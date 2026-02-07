import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CounterClient } from './client';

function createMockRedis() {
  return {
    xadd: vi.fn().mockResolvedValue('1234567890-0'),
    quit: vi.fn().mockResolvedValue('OK'),
  };
}

describe('CounterClient', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let client: CounterClient;

  beforeEach(() => {
    redis = createMockRedis();
    client = new CounterClient({ redis: redis as any });
  });

  describe('inc', () => {
    it('should XADD with delta +1 and MAXLEN trimming', async () => {
      await client.inc('post:1:likes');

      expect(redis.xadd).toHaveBeenCalledOnce();
      const args = redis.xadd.mock.calls[0];
      // With default maxStreamLength, should include MAXLEN
      expect(args[0]).toBe('counter-bridge:events');
      expect(args[1]).toBe('MAXLEN');
      expect(args[2]).toBe('~');
      expect(args[3]).toBe('100000');
      expect(args[4]).toBe('*');
      expect(args[5]).toBe('scope');
      expect(args[6]).toBe('post:1:likes');
      expect(args[7]).toBe('delta');
      expect(args[8]).toBe('1');
    });
  });

  describe('dec', () => {
    it('should XADD with delta -1', async () => {
      await client.dec('post:1:likes');

      const args = redis.xadd.mock.calls[0];
      expect(args[8]).toBe('-1');
    });
  });

  describe('add', () => {
    it('should XADD with arbitrary delta', async () => {
      await client.add('post:1:views', 50);

      const args = redis.xadd.mock.calls[0];
      expect(args[6]).toBe('post:1:views');
      expect(args[8]).toBe('50');
    });

    it('should include metadata when provided', async () => {
      await client.add('post:1:likes', 1, { model: 'Post', tags: { region: 'us' } });

      const args = redis.xadd.mock.calls[0];
      // metadata fields come after timestamp
      expect(args[11]).toBe('metadata');
      const parsed = JSON.parse(args[12]);
      expect(parsed.model).toBe('Post');
      expect(parsed.tags.region).toBe('us');
    });

    it('should include timestamp in every event', async () => {
      const before = Date.now();
      await client.add('x', 1);
      const after = Date.now();

      const args = redis.xadd.mock.calls[0];
      expect(args[9]).toBe('timestamp');
      const ts = Number(args[10]);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  describe('stream trimming', () => {
    it('should disable MAXLEN when maxStreamLength is 0', async () => {
      const noTrimClient = new CounterClient({
        redis: redis as any,
        maxStreamLength: 0,
      });

      await noTrimClient.inc('x');

      const args = redis.xadd.mock.calls[0];
      expect(args[0]).toBe('counter-bridge:events');
      expect(args[1]).toBe('*'); // no MAXLEN prefix
    });

    it('should use custom maxStreamLength', async () => {
      const customClient = new CounterClient({
        redis: redis as any,
        maxStreamLength: 5000,
      });

      await customClient.inc('x');

      const args = redis.xadd.mock.calls[0];
      expect(args[3]).toBe('5000');
    });
  });

  describe('custom stream key', () => {
    it('should use custom stream key when provided', async () => {
      const customClient = new CounterClient({
        redis: redis as any,
        streamKey: 'my-app:counters',
      });

      await customClient.inc('x');
      expect(redis.xadd.mock.calls[0][0]).toBe('my-app:counters');
    });
  });

  describe('close', () => {
    it('should not quit redis when connection was passed in', async () => {
      await client.close();
      expect(redis.quit).not.toHaveBeenCalled();
    });
  });
});
