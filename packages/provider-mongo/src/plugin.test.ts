import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Schema } from 'mongoose';

// Mock the SDK module before any imports that use it
const mockClientInstance = {
  inc: vi.fn().mockResolvedValue(undefined),
  dec: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@counter-bridge/sdk', () => {
  return {
    CounterClient: class MockCounterClient {
      constructor() {
        return mockClientInstance;
      }
    },
  };
});

import { counterPlugin } from './plugin';
import { setup, getClient, shutdown } from './setup';

/**
 * Create a minimal document-like object that has the methods
 * added by counterPlugin.
 */
function createPluginDoc(fields: string[], scopePrefix: string, docId: string) {
  const schema = new Schema({});
  counterPlugin(schema, { fields, scopePrefix });

  // Extract the methods registered on the schema
  const methods = (schema as any).methods;

  // Build a fake document with those methods bound
  const doc: any = {
    _id: docId,
    constructor: { modelName: scopePrefix },
  };

  for (const [name, fn] of Object.entries(methods)) {
    doc[name] = (fn as Function).bind(doc);
  }

  return doc;
}

describe('plugin write methods', () => {
  beforeEach(async () => {
    await shutdown();
    mockClientInstance.inc.mockClear();
    mockClientInstance.dec.mockClear();
    mockClientInstance.add.mockClear();
    mockClientInstance.close.mockClear();
    setup({ redisUrl: 'redis://localhost:6379' });
  });

  afterEach(async () => {
    await shutdown();
  });

  it('inc() calls client.inc with correct scope', async () => {
    const doc = createPluginDoc(['likes', 'views'], 'post', '123');

    await doc.inc('likes');

    expect(mockClientInstance.inc).toHaveBeenCalledOnce();
    expect(mockClientInstance.inc).toHaveBeenCalledWith('v1:post:123:likes', undefined);
  });

  it('dec() calls client.dec with correct scope', async () => {
    const doc = createPluginDoc(['likes', 'views'], 'post', '456');

    await doc.dec('views');

    expect(mockClientInstance.dec).toHaveBeenCalledOnce();
    expect(mockClientInstance.dec).toHaveBeenCalledWith('v1:post:456:views', undefined);
  });

  it('add() calls client.add with correct scope and delta', async () => {
    const doc = createPluginDoc(['likes', 'views'], 'post', '789');

    await doc.add('views', 10);

    expect(mockClientInstance.add).toHaveBeenCalledOnce();
    expect(mockClientInstance.add).toHaveBeenCalledWith('v1:post:789:views', 10, undefined);
  });

  it('inc() forwards metadata to client', async () => {
    const doc = createPluginDoc(['likes'], 'post', '100');
    const meta = { model: 'Post', tags: { region: 'us' } };

    await doc.inc('likes', meta);

    expect(mockClientInstance.inc).toHaveBeenCalledWith('v1:post:100:likes', meta);
  });

  it('dec() forwards metadata to client', async () => {
    const doc = createPluginDoc(['likes'], 'post', '101');
    const meta = { model: 'Post' };

    await doc.dec('likes', meta);

    expect(mockClientInstance.dec).toHaveBeenCalledWith('v1:post:101:likes', meta);
  });

  it('add() forwards metadata to client', async () => {
    const doc = createPluginDoc(['views'], 'post', '102');
    const meta = { model: 'Post' };

    await doc.add('views', 5, meta);

    expect(mockClientInstance.add).toHaveBeenCalledWith('v1:post:102:views', 5, meta);
  });
});

describe('setup singleton', () => {
  afterEach(async () => {
    await shutdown();
  });

  it('throws if getClient() called before setup()', () => {
    expect(() => getClient()).toThrow('Call counterBridge.setup() before using counter write methods.');
  });

  it('throws if setup() called twice', () => {
    setup({ redisUrl: 'redis://localhost:6379' });

    expect(() => setup({ redisUrl: 'redis://localhost:6379' })).toThrow(
      'counterBridge.setup() has already been called. Call shutdown() first to reconfigure.'
    );
  });

  it('shutdown() resets singleton so setup() can be called again', async () => {
    setup({ redisUrl: 'redis://localhost:6379' });
    await shutdown();

    // Should not throw
    setup({ redisUrl: 'redis://localhost:6380' });
    expect(() => getClient()).not.toThrow();
  });

  it('shutdown() is safe to call when no client exists', async () => {
    // Should not throw
    await shutdown();
  });

  it('getClient() returns the client after setup()', () => {
    setup({ redisUrl: 'redis://localhost:6379' });
    const client = getClient();
    expect(client).toBeDefined();
  });
});
