import mongoose from 'mongoose';
import { CounterBridge } from '@counter-bridge/core';
import { MongoProvider } from '@counter-bridge/provider-mongo';
import { loadConfig } from './config';
import { Logger } from './logger';
import { createHealthServer } from './health';
import { setupSignalHandlers } from './signals';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logging.level);

  logger.info('Starting CounterBridge consumer', {
    streamKey: config.stream.key,
    consumerGroup: config.stream.consumerGroup,
    consumerId: config.stream.consumerId,
  });

  // Connect to MongoDB
  await mongoose.connect(config.mongodb.uri);
  logger.info('Connected to MongoDB');

  // Create provider and bridge
  const provider = new MongoProvider({
    collectionName: config.mongodb.collectionName,
  });

  const bridge = new CounterBridge({
    redis: config.redis.url,
    provider,
    streamKey: config.stream.key,
    consumerGroup: config.stream.consumerGroup,
    consumerId: config.stream.consumerId,
    batching: {
      maxWaitMs: config.batching.maxWaitMs,
      maxMessages: config.batching.maxMessages,
    },
  });

  // Wire bridge events to logger
  bridge.on('started', () => logger.info('Bridge started'));
  bridge.on('stopped', () => logger.info('Bridge stopped'));
  bridge.on('flush', (stats) => logger.debug('Flush completed', stats));
  bridge.on('recovery', (count) => logger.info('PEL recovery', { recovered: count }));
  bridge.on('error', (err) => logger.error('Bridge error', { error: String(err) }));
  bridge.on('warn', (msg) => logger.warn('Bridge warning', { detail: msg }));

  // Health server
  let healthServer: ReturnType<typeof createHealthServer> | undefined;
  if (config.health.enabled) {
    healthServer = createHealthServer({ port: config.health.port, bridge });
    logger.info('Health server listening', { port: config.health.port });
  }

  // Signal handlers
  setupSignalHandlers({
    logger,
    onShutdown: async () => {
      logger.info('Shutting down...');
      await bridge.stop();
      if (healthServer) {
        await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
      }
      await mongoose.disconnect();
      logger.info('Shutdown complete');
    },
  });

  // Start the bridge
  await bridge.start();
  logger.info('CounterBridge consumer is running');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
