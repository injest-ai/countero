import fs from 'fs';
import { parse as parseYaml } from 'yaml';
import { configSchema, ValidatedConfig } from './schema';

const ENV_PREFIX = 'COUNTER_BRIDGE_';

const ENV_MAP: Record<string, (config: any, value: string) => void> = {
  [`${ENV_PREFIX}REDIS_URL`]: (c, v) => { c.redis = c.redis || {}; c.redis.url = v; },
  [`${ENV_PREFIX}MONGODB_URI`]: (c, v) => { c.mongodb = c.mongodb || {}; c.mongodb.uri = v; },
  [`${ENV_PREFIX}MONGODB_COLLECTION`]: (c, v) => { c.mongodb = c.mongodb || {}; c.mongodb.collectionName = v; },
  [`${ENV_PREFIX}STREAM_KEY`]: (c, v) => { c.stream = c.stream || {}; c.stream.key = v; },
  [`${ENV_PREFIX}STREAM_CONSUMER_GROUP`]: (c, v) => { c.stream = c.stream || {}; c.stream.consumerGroup = v; },
  [`${ENV_PREFIX}STREAM_CONSUMER_ID`]: (c, v) => { c.stream = c.stream || {}; c.stream.consumerId = v; },
  [`${ENV_PREFIX}BATCHING_MAX_WAIT_MS`]: (c, v) => { c.batching = c.batching || {}; c.batching.maxWaitMs = parseInt(v, 10); },
  [`${ENV_PREFIX}BATCHING_MAX_MESSAGES`]: (c, v) => { c.batching = c.batching || {}; c.batching.maxMessages = parseInt(v, 10); },
  [`${ENV_PREFIX}LOG_LEVEL`]: (c, v) => { c.logging = c.logging || {}; c.logging.level = v; },
  [`${ENV_PREFIX}HEALTH_ENABLED`]: (c, v) => { c.health = c.health || {}; c.health.enabled = v === 'true'; },
  [`${ENV_PREFIX}HEALTH_PORT`]: (c, v) => { c.health = c.health || {}; c.health.port = parseInt(v, 10); },
};

export function loadConfig(configPath?: string): ValidatedConfig {
  const filePath = configPath ?? process.env.CONFIG_PATH ?? '/etc/counter-bridge/config.yaml';

  let raw: Record<string, any> = {};

  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    raw = parseYaml(content) ?? {};
  }

  // Apply environment variable overrides
  for (const [envKey, setter] of Object.entries(ENV_MAP)) {
    const value = process.env[envKey];
    if (value !== undefined) {
      setter(raw, value);
    }
  }

  return configSchema.parse(raw);
}
