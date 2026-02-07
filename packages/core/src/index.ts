export { CounterBridge } from './consumer';
export { Aggregator } from './aggregator';

// Re-export types consumers need
export type {
  CoreConfig,
  BatchingConfig,
  CounterEvent,
  SyncStats,
  ICounterProvider,
  FlushResult,
  ScopeMetadata,
} from '@counter-bridge/types';
