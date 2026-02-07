import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CounterBridge } from './consumer';
import type { ICounterProvider } from '@counter-bridge/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A promise that never resolves — used to park the readLoop. */
function hang(): Promise<null> {
  return new Promise(() => {});
}

function createMockRedis() {
  return {
    xgroup: vi.fn().mockResolvedValue('OK'),
    // First call (PEL recovery) returns null, then hang forever for readLoop
    xreadgroup: vi.fn().mockResolvedValueOnce(null).mockReturnValue(hang()),
    xack: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue('OK'),
  };
}

function createMockProvider(): ICounterProvider & {
  flush: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  getBatch: ReturnType<typeof vi.fn>;
  initialize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    flush: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(0),
    getBatch: vi.fn().mockResolvedValue(new Map()),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CounterBridge', () => {
  let provider: ReturnType<typeof createMockProvider>;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    provider = createMockProvider();
    redis = createMockRedis();
  });

  function createBridge(overrides = {}) {
    return new CounterBridge({
      redis: redis as any,
      provider,
      streamKey: 'test:stream',
      consumerGroup: 'test-group',
      consumerId: 'test-consumer',
      batching: { maxWaitMs: 500, maxMessages: 1000 },
      ...overrides,
    });
  }

  describe('start', () => {
    it('should initialize the provider on start', async () => {
      const bridge = createBridge();
      await bridge.start();
      expect(provider.initialize).toHaveBeenCalledOnce();
      await bridge.stop();
    });

    it('should create a consumer group on start', async () => {
      const bridge = createBridge();
      await bridge.start();
      expect(redis.xgroup).toHaveBeenCalledWith(
        'CREATE', 'test:stream', 'test-group', '0', 'MKSTREAM'
      );
      await bridge.stop();
    });

    it('should tolerate BUSYGROUP error (group already exists)', async () => {
      redis.xgroup.mockRejectedValueOnce(new Error('BUSYGROUP Consumer Group name already exists'));
      const bridge = createBridge();
      await expect(bridge.start()).resolves.not.toThrow();
      await bridge.stop();
    });

    it('should re-throw non-BUSYGROUP errors', async () => {
      redis.xgroup.mockRejectedValueOnce(new Error('Connection refused'));
      const bridge = createBridge();
      await expect(bridge.start()).rejects.toThrow('Connection refused');
    });

    it('should not start twice', async () => {
      const bridge = createBridge();
      await bridge.start();
      await bridge.start();
      expect(provider.initialize).toHaveBeenCalledOnce();
      await bridge.stop();
    });

    it('should recover pending messages on start (PEL recovery)', async () => {
      // First call (PEL recovery with '0') returns messages, then hang for readLoop
      redis.xreadgroup.mockReset()
        .mockResolvedValueOnce([
          ['test:stream', [
            ['1-0', ['scope', 'post:1:likes', 'delta', '3', 'timestamp', '1000']],
          ]],
        ])
        .mockReturnValue(hang());

      const bridge = createBridge();
      await bridge.start();

      expect(provider.flush).toHaveBeenCalledOnce();
      const flushedBatch = provider.flush.mock.calls[0][0] as Map<string, number>;
      expect(flushedBatch.get('post:1:likes')).toBe(3);
      expect(redis.xack).toHaveBeenCalledWith('test:stream', 'test-group', '1-0');

      await bridge.stop();
    });
  });

  describe('stop', () => {
    it('should close the provider on stop', async () => {
      const bridge = createBridge();
      await bridge.start();
      await bridge.stop();
      expect(provider.close).toHaveBeenCalledOnce();
    });

    it('should quit redis on stop', async () => {
      const bridge = createBridge();
      await bridge.start();
      await bridge.stop();
      expect(redis.quit).toHaveBeenCalledOnce();
    });

    it('should emit started and stopped events', async () => {
      const bridge = createBridge();
      const started = vi.fn();
      const stopped = vi.fn();
      bridge.on('started', started);
      bridge.on('stopped', stopped);

      await bridge.start();
      expect(started).toHaveBeenCalledOnce();

      await bridge.stop();
      expect(stopped).toHaveBeenCalledOnce();
    });
  });

  describe('at-least-once delivery', () => {
    it('should ACK messages only after successful flush (via PEL recovery)', async () => {
      redis.xreadgroup.mockReset()
        .mockResolvedValueOnce([
          ['test:stream', [
            ['2-0', ['scope', 'x', 'delta', '1', 'timestamp', '1000']],
          ]],
        ])
        .mockReturnValue(hang());

      const bridge = createBridge();
      await bridge.start();

      // Flush happens during PEL recovery in start()
      expect(provider.flush).toHaveBeenCalled();
      // ACK happens after successful flush
      expect(redis.xack).toHaveBeenCalledWith('test:stream', 'test-group', '2-0');

      await bridge.stop();
    });

    it('should NOT ACK messages when flush fails', async () => {
      provider.flush.mockRejectedValueOnce(new Error('DB down'));

      redis.xreadgroup.mockReset()
        .mockResolvedValueOnce([
          ['test:stream', [
            ['3-0', ['scope', 'y', 'delta', '1', 'timestamp', '1000']],
          ]],
        ])
        .mockReturnValue(hang());

      const bridge = createBridge();
      bridge.on('error', () => {});
      await bridge.start();

      // Flush was attempted during PEL recovery but failed
      expect(provider.flush).toHaveBeenCalled();
      // ACK should NOT have been called
      expect(redis.xack).not.toHaveBeenCalled();

      await bridge.stop();
    });
  });

  describe('partial flush failure', () => {
    it('should re-add only failed scopes from FlushResult', async () => {
      const failedMap = new Map([['b', 2]]);
      provider.flush.mockResolvedValueOnce({ failed: failedMap });

      redis.xreadgroup.mockReset()
        .mockResolvedValueOnce([
          ['test:stream', [
            ['4-0', ['scope', 'a', 'delta', '1', 'timestamp', '1000']],
            ['5-0', ['scope', 'b', 'delta', '2', 'timestamp', '1000']],
          ]],
        ])
        .mockReturnValue(hang());

      const bridge = createBridge();
      const warns: any[] = [];
      bridge.on('warn', (w) => warns.push(w));
      await bridge.start();

      expect(provider.flush).toHaveBeenCalled();
      // Messages get ACK'd (the non-failed scopes persisted)
      expect(redis.xack).toHaveBeenCalled();
      expect(warns.some((w) => w.message === 'Partial flush failure')).toBe(true);

      await bridge.stop();
    });
  });

  describe('stats', () => {
    it('should return initial stats', () => {
      const bridge = createBridge();
      const stats = bridge.getStats();
      expect(stats.eventsProcessed).toBe(0);
      expect(stats.flushCount).toBe(0);
      expect(stats.errorCount).toBe(0);
      expect(stats.pendingMessages).toBe(0);
    });
  });

  describe('get / getBatch', () => {
    it('should delegate get() to the provider', async () => {
      provider.get.mockResolvedValueOnce(42);
      const bridge = createBridge();
      const value = await bridge.get('post:1:likes');
      expect(value).toBe(42);
      expect(provider.get).toHaveBeenCalledWith('post:1:likes');
    });

    it('should delegate getBatch() to the provider when available', async () => {
      const result = new Map([['a', 1], ['b', 2]]);
      provider.getBatch.mockResolvedValueOnce(result);
      const bridge = createBridge();
      const values = await bridge.getBatch(['a', 'b']);
      expect(values).toEqual(result);
    });

    it('should fall back to individual gets when getBatch is not available', async () => {
      const providerNoBatch: ICounterProvider = {
        flush: vi.fn(),
        get: vi.fn()
          .mockResolvedValueOnce(10)
          .mockResolvedValueOnce(20),
      };

      const bridge = new CounterBridge({
        redis: redis as any,
        provider: providerNoBatch,
      });

      const values = await bridge.getBatch(['a', 'b']);
      expect(values.get('a')).toBe(10);
      expect(values.get('b')).toBe(20);
    });
  });

  describe('parseEvent', () => {
    it('should emit warn for malformed events', async () => {
      redis.xreadgroup.mockReset()
        .mockResolvedValueOnce([
          ['test:stream', [
            ['7-0', ['bad', 'data']],
          ]],
        ])
        .mockReturnValue(hang());

      const bridge = createBridge();
      const warns: any[] = [];
      bridge.on('warn', (w) => warns.push(w));
      await bridge.start();

      expect(warns.some((w) => w.message === 'Dropped malformed event')).toBe(true);

      await bridge.stop();
    });

    it('should handle malformed JSON metadata gracefully', async () => {
      redis.xreadgroup.mockReset()
        .mockResolvedValueOnce([
          ['test:stream', [
            ['8-0', ['scope', 'x', 'delta', '1', 'timestamp', '1000', 'metadata', '{bad}']],
          ]],
        ])
        .mockReturnValue(hang());

      const bridge = createBridge();
      const warns: any[] = [];
      bridge.on('warn', (w) => warns.push(w));
      await bridge.start();

      // Event with bad metadata should still be processed — flush happens in recovery
      expect(provider.flush).toHaveBeenCalled();
      expect(warns.some((w) => w.message === 'Failed to parse event metadata')).toBe(true);

      await bridge.stop();
    });
  });
});
