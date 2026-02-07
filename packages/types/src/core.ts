import type { ICounterProvider } from './provider';
import type { ScopeMetadata } from './provider';

/**
 * Configuration for the core CounterBridge sync engine
 */
export interface CoreConfig {
  /** Redis connection URL string or an ioredis client instance */
  redis: string | { [key: string]: any };

  /** Persistence backend provider */
  provider: ICounterProvider;

  /** Redis Stream key name. Default: "counter-bridge:events" */
  streamKey?: string;

  /** Consumer group name. Default: "counter-bridge-group" */
  consumerGroup?: string;

  /** Unique consumer ID within the group. Default: auto-generated */
  consumerId?: string;

  /** Flush trigger options */
  batching?: BatchingConfig;
}

/**
 * Batching and windowing configuration
 */
export interface BatchingConfig {
  /** Maximum time (ms) to wait before flushing. Default: 500 */
  maxWaitMs?: number;

  /** Maximum number of messages to batch before forcing a flush. Default: 1000 */
  maxMessages?: number;
}

/**
 * Counter increment/decrement event
 */
export interface CounterEvent {
  /** Scope identifier (e.g., 'v1:post:123:likes') */
  scope: string;

  /** Delta value (positive for increment, negative for decrement) */
  delta: number;

  /** Optional metadata for routing */
  metadata?: ScopeMetadata;

  /** Event timestamp (epoch ms) */
  timestamp?: number;
}

/**
 * Sync statistics for monitoring
 */
export interface SyncStats {
  /** Total events processed */
  eventsProcessed: number;

  /** Total flush operations */
  flushCount: number;

  /** Last flush timestamp */
  lastFlushAt?: Date;

  /** Current pending message count */
  pendingMessages: number;

  /** Average batch size */
  avgBatchSize: number;

  /** Errors encountered */
  errorCount: number;
}
