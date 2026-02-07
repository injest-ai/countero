import Redis from 'ioredis';
import type { ScopeMetadata } from '@counter-bridge/types';

const DEFAULT_STREAM_KEY = 'counter-bridge:events';
const DEFAULT_MAX_LEN = 100_000;

export interface CounterClientConfig {
  /** Redis connection URL or ioredis instance. */
  redis: string | Redis;
  /** Stream key name. Default: "counter-bridge:events". */
  streamKey?: string;
  /** Approximate max stream length for auto-trimming. Default: 100000. Set to 0 to disable. */
  maxStreamLength?: number;
}

/**
 * Lightweight client SDK for pushing counter events.
 *
 * Usage:
 * ```ts
 * const counter = new CounterClient({ redis: 'redis://localhost:6379' });
 * await counter.inc('v1:post:123:likes');
 * await counter.dec('v1:post:123:likes');
 * await counter.add('v1:post:123:views', 10);
 * await counter.close();
 * ```
 */
export class CounterClient {
  private redis: Redis;
  private streamKey: string;
  private maxStreamLength: number;
  private ownsConnection: boolean;

  constructor(config: CounterClientConfig) {
    if (typeof config.redis === 'string') {
      this.redis = new Redis(config.redis);
      this.ownsConnection = true;
    } else {
      this.redis = config.redis;
      this.ownsConnection = false;
    }
    this.streamKey = config.streamKey ?? DEFAULT_STREAM_KEY;
    this.maxStreamLength = config.maxStreamLength ?? DEFAULT_MAX_LEN;
  }

  /** Increment a scope by 1. */
  async inc(scope: string, metadata?: ScopeMetadata): Promise<void> {
    await this.add(scope, 1, metadata);
  }

  /** Decrement a scope by 1. */
  async dec(scope: string, metadata?: ScopeMetadata): Promise<void> {
    await this.add(scope, -1, metadata);
  }

  /** Add an arbitrary delta to a scope. */
  async add(scope: string, delta: number, metadata?: ScopeMetadata): Promise<void> {
    const fields: string[] = [
      'scope', scope,
      'delta', String(delta),
      'timestamp', String(Date.now()),
    ];

    if (metadata) {
      fields.push('metadata', JSON.stringify(metadata));
    }

    if (this.maxStreamLength > 0) {
      // Approximate trimming (~) is O(1) and keeps the stream bounded
      await this.redis.xadd(
        this.streamKey, 'MAXLEN', '~', String(this.maxStreamLength), '*', ...fields
      );
    } else {
      await this.redis.xadd(this.streamKey, '*', ...fields);
    }
  }

  /** Close the Redis connection (only if this client created it). */
  async close(): Promise<void> {
    if (this.ownsConnection) {
      await this.redis.quit();
    }
  }
}
