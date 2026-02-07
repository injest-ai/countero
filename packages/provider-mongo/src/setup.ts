import { CounterClient } from '@counter-bridge/sdk';

export interface CounterBridgeSetupConfig {
  redisUrl: string;
  streamKey?: string;
  maxStreamLength?: number;
}

let client: CounterClient | null = null;

export function setup(config: CounterBridgeSetupConfig): void {
  if (client) {
    throw new Error('counterBridge.setup() has already been called. Call shutdown() first to reconfigure.');
  }
  client = new CounterClient({
    redis: config.redisUrl,
    streamKey: config.streamKey,
    maxStreamLength: config.maxStreamLength,
  });
}

export function getClient(): CounterClient {
  if (!client) {
    throw new Error('Call counterBridge.setup() before using counter write methods.');
  }
  return client;
}

export async function shutdown(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}

export const counterBridge = { setup, getClient, shutdown };
