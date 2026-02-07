export interface ConsumerConfig {
  redis: {
    url: string;
  };
  mongodb: {
    uri: string;
    collectionName?: string;
  };
  stream: {
    key?: string;
    consumerGroup?: string;
    consumerId?: string;
  };
  batching: {
    maxWaitMs?: number;
    maxMessages?: number;
  };
  logging: {
    level?: 'debug' | 'info' | 'warn' | 'error';
  };
  health: {
    enabled?: boolean;
    port?: number;
  };
}
