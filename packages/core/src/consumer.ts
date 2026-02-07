import Redis from 'ioredis';
import { EventEmitter } from 'events';
import type { CoreConfig, ICounterProvider, CounterEvent, SyncStats } from '@counter-bridge/types';
import { Aggregator } from './aggregator';

const DEFAULTS = {
  STREAM_KEY: 'counter-bridge:events',
  GROUP_NAME: 'counter-bridge-group',
  WINDOW_MS: 500,
  MAX_BATCH_SIZE: 1000,
};

/**
 * Core CounterBridge engine.
 *
 * Reads from a Redis Stream using Consumer Groups, aggregates deltas
 * in-memory via windowing, and flushes batches to the configured provider.
 *
 * Guarantees at-least-once delivery: messages are only ACK'd after the
 * provider successfully persists them.
 */
export class CounterBridge extends EventEmitter {
  private redis: Redis;
  private provider: ICounterProvider;
  private aggregator: Aggregator;
  private running = false;
  private flushing: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingIds: string[] = [];

  private readonly streamKey: string;
  private readonly groupName: string;
  private readonly consumerName: string;
  private readonly windowMs: number;
  private readonly maxBatchSize: number;

  private stats: SyncStats = {
    eventsProcessed: 0,
    flushCount: 0,
    lastFlushAt: undefined,
    pendingMessages: 0,
    avgBatchSize: 0,
    errorCount: 0,
  };

  constructor(config: CoreConfig) {
    super();
    this.redis = typeof config.redis === 'string'
      ? new Redis(config.redis as string)
      : config.redis as Redis;
    this.provider = config.provider;
    this.aggregator = new Aggregator();

    this.streamKey = config.streamKey ?? DEFAULTS.STREAM_KEY;
    this.groupName = config.consumerGroup ?? DEFAULTS.GROUP_NAME;
    this.consumerName = config.consumerId ?? `consumer-${process.pid}-${Date.now()}`;
    this.windowMs = config.batching?.maxWaitMs ?? DEFAULTS.WINDOW_MS;
    this.maxBatchSize = config.batching?.maxMessages ?? DEFAULTS.MAX_BATCH_SIZE;
  }

  /** Start consuming from the Redis Stream. */
  async start(): Promise<void> {
    if (this.running) return;

    if (this.provider.initialize) {
      await this.provider.initialize();
    }

    // Ensure consumer group exists (MKSTREAM creates the stream if needed)
    try {
      await this.redis.xgroup('CREATE', this.streamKey, this.groupName, '0', 'MKSTREAM');
    } catch (err: any) {
      if (!err.message?.includes('BUSYGROUP')) throw err;
    }

    this.running = true;
    this.emit('started');

    // Recover any pending messages from a previous crash before reading new ones
    await this.recoverPending();

    // Start the read loop and flush timer
    this.readLoop();
    this.scheduleFlush();
  }

  /** Gracefully stop the consumer. */
  async stop(): Promise<void> {
    this.running = false;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Wait for any in-flight flush to complete
    if (this.flushing) {
      await this.flushing;
    }

    // Final flush of any remaining data
    await this.flush();

    if (this.provider.close) {
      await this.provider.close();
    }

    await this.redis.quit();
    this.emit('stopped');
  }

  /** Get current sync statistics. */
  getStats(): Readonly<SyncStats> {
    return { ...this.stats, pendingMessages: this.aggregator.size };
  }

  /** Read a counter value from the persistent store. */
  async get(scope: string): Promise<number> {
    return this.provider.get(scope);
  }

  /** Batch-read counter values from the persistent store. */
  async getBatch(scopes: string[]): Promise<Map<string, number>> {
    if (this.provider.getBatch) {
      return this.provider.getBatch(scopes);
    }
    const entries = await Promise.all(
      scopes.map(async (scope) => [scope, await this.provider.get(scope)] as const)
    );
    return new Map(entries);
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /**
   * On startup, reclaim any messages left in the PEL (Pending Entries List)
   * from a previous crash. Read with ID '0' to get pending messages,
   * then process them before switching to '>' for new messages.
   */
  private async recoverPending(): Promise<void> {
    try {
      const results = await this.redis.xreadgroup(
        'GROUP', this.groupName, this.consumerName,
        'COUNT', this.maxBatchSize,
        'STREAMS', this.streamKey, '0'
      ) as [string, [string, string[]][]][] | null;

      if (!results) return;

      for (const [, messages] of results) {
        if (messages.length === 0) continue;
        for (const [id, fields] of messages) {
          const event = this.parseEvent(fields);
          if (event) {
            this.aggregator.add(event);
            this.pendingIds.push(id);
            this.stats.eventsProcessed++;
          }
        }
      }

      // Flush recovered messages immediately
      if (this.aggregator.size > 0) {
        this.emit('recovery', { messageCount: this.aggregator.size });
        await this.flush();
      }
    } catch (err) {
      this.stats.errorCount++;
      this.emit('error', err);
    }
  }

  private async readLoop(): Promise<void> {
    while (this.running) {
      try {
        const results = await this.redis.xreadgroup(
          'GROUP', this.groupName, this.consumerName,
          'COUNT', this.maxBatchSize,
          'BLOCK', this.windowMs,
          'STREAMS', this.streamKey, '>'
        ) as [string, [string, string[]][]][] | null;

        if (!results) continue;

        for (const [, messages] of results) {
          for (const [id, fields] of messages) {
            const event = this.parseEvent(fields);
            if (event) {
              this.aggregator.add(event);
              this.pendingIds.push(id);
              this.stats.eventsProcessed++;
            }
          }
        }

        // If we hit the batch size limit, flush immediately
        if (this.aggregator.size >= this.maxBatchSize) {
          await this.flush();
        }
      } catch (err) {
        this.stats.errorCount++;
        this.emit('error', err);
        await this.sleep(1000);
      }
    }
  }

  private scheduleFlush(): void {
    if (!this.running) return;

    this.flushTimer = setTimeout(async () => {
      if (this.aggregator.size > 0) {
        await this.flush();
      }
      this.scheduleFlush();
    }, this.windowMs);
  }

  /**
   * Flush aggregated deltas to the provider, then ACK the messages.
   * Uses a mutex to prevent concurrent flushes from the timer and readLoop.
   */
  private async flush(): Promise<void> {
    // Mutex: if already flushing, wait for it to finish
    if (this.flushing) {
      await this.flushing;
      return;
    }

    if (this.aggregator.size === 0) return;

    this.flushing = this.doFlush();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async doFlush(): Promise<void> {
    const batch = this.aggregator.drain();
    const idsToAck = this.pendingIds.splice(0);

    try {
      const result = await this.provider.flush(batch);

      // Handle partial failures: re-add only the failed scopes
      if (result?.failed && result.failed.size > 0) {
        for (const [scope, delta] of result.failed) {
          this.aggregator.add({ scope, delta, timestamp: Date.now() });
        }
        this.emit('warn', {
          message: 'Partial flush failure',
          failedScopes: result.failed.size,
          totalScopes: batch.size,
        });
      }

      // ACK only after successful persistence (at-least-once guarantee)
      if (idsToAck.length > 0) {
        await (this.redis as any).xack(this.streamKey, this.groupName, ...idsToAck);
      }

      this.stats.flushCount++;
      this.stats.lastFlushAt = new Date();
      this.stats.avgBatchSize = Math.round(
        (this.stats.avgBatchSize * (this.stats.flushCount - 1) + batch.size) / this.stats.flushCount
      );
      this.emit('flush', { scopeCount: batch.size, flushNumber: this.stats.flushCount });
    } catch (err) {
      this.stats.errorCount++;
      this.emit('error', err);

      // Total failure: re-add all deltas for retry.
      // IDs stay un-ACK'd so Redis will redeliver on restart.
      for (const [scope, delta] of batch) {
        this.aggregator.add({ scope, delta, timestamp: Date.now() });
      }
      this.pendingIds.unshift(...idsToAck);
    }
  }

  /**
   * Parse Redis Stream field array into a CounterEvent.
   * Uses a linear scan instead of Map allocation for efficiency.
   */
  private parseEvent(fields: string[]): CounterEvent | null {
    let scope: string | undefined;
    let delta: string | undefined;
    let timestamp: string | undefined;
    let metadata: string | undefined;

    for (let i = 0; i < fields.length; i += 2) {
      switch (fields[i]) {
        case 'scope': scope = fields[i + 1]; break;
        case 'delta': delta = fields[i + 1]; break;
        case 'timestamp': timestamp = fields[i + 1]; break;
        case 'metadata': metadata = fields[i + 1]; break;
      }
    }

    if (!scope || delta === undefined) {
      this.emit('warn', { message: 'Dropped malformed event', fields });
      return null;
    }

    let parsedMetadata: CounterEvent['metadata'];
    if (metadata) {
      try {
        parsedMetadata = JSON.parse(metadata);
      } catch {
        this.emit('warn', { message: 'Failed to parse event metadata', scope });
      }
    }

    return {
      scope,
      delta: Number(delta),
      timestamp: Number(timestamp ?? Date.now()),
      metadata: parsedMetadata,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
