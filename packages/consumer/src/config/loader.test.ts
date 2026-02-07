import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { loadConfig } from './loader';

vi.mock('fs');

const VALID_YAML = `
redis:
  url: redis://localhost:6379
mongodb:
  uri: mongodb://localhost:27017/test
`;

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(VALID_YAML);
  // Clear env vars
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('COUNTER_BRIDGE_')) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadConfig', () => {
  it('should load and validate a YAML config file', () => {
    const config = loadConfig('/test/config.yaml');
    expect(config.redis.url).toBe('redis://localhost:6379');
    expect(config.mongodb.uri).toBe('mongodb://localhost:27017/test');
  });

  it('should apply default values', () => {
    const config = loadConfig('/test/config.yaml');
    expect(config.stream.key).toBe('counter-bridge:events');
    expect(config.stream.consumerGroup).toBe('counter-bridge-group');
    expect(config.batching.maxWaitMs).toBe(500);
    expect(config.batching.maxMessages).toBe(1000);
    expect(config.logging.level).toBe('info');
    expect(config.health.enabled).toBe(true);
    expect(config.health.port).toBe(9090);
    expect(config.mongodb.collectionName).toBe('counters');
  });

  it('should override values from environment variables', () => {
    process.env.COUNTER_BRIDGE_REDIS_URL = 'redis://override:6380';
    process.env.COUNTER_BRIDGE_STREAM_KEY = 'custom:stream';
    process.env.COUNTER_BRIDGE_BATCHING_MAX_WAIT_MS = '1000';
    process.env.COUNTER_BRIDGE_LOG_LEVEL = 'debug';

    const config = loadConfig('/test/config.yaml');
    expect(config.redis.url).toBe('redis://override:6380');
    expect(config.stream.key).toBe('custom:stream');
    expect(config.batching.maxWaitMs).toBe(1000);
    expect(config.logging.level).toBe('debug');
  });

  it('should throw on invalid config (missing required fields)', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('logging:\n  level: info\n');
    expect(() => loadConfig('/test/config.yaml')).toThrow();
  });

  it('should work with env vars only (no config file)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    process.env.COUNTER_BRIDGE_REDIS_URL = 'redis://env:6379';
    process.env.COUNTER_BRIDGE_MONGODB_URI = 'mongodb://env:27017/test';

    const config = loadConfig('/nonexistent.yaml');
    expect(config.redis.url).toBe('redis://env:6379');
    expect(config.mongodb.uri).toBe('mongodb://env:27017/test');
  });
});
