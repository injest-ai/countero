# CounterBridge

High-throughput counter synchronization service. Aggregates increment/decrement events from a Redis Stream, folds them in-memory, and flushes batched deltas to any persistence backend.

```
App → CounterClient.inc() → Redis Stream → CounterBridge → Aggregator → Provider → MongoDB
```

100k individual `+1` events become a single `$inc: { value: 100000 }` write.

## Why

Naive counter updates (`UPDATE posts SET likes = likes + 1`) under high concurrency create write contention, lock waits, and wasted IOPS. CounterBridge solves this by:

- **Decoupling writes** — producers fire-and-forget into a Redis Stream
- **Folding deltas** — the Aggregator collapses `[+1, +1, -1]` into `+1` before touching the database
- **Batching flushes** — one `bulkWrite` per window (default 500ms) instead of per-event
- **At-least-once delivery** — messages are only ACK'd after successful persistence; crashes recover from the PEL

## Quick Start

```bash
npm install @counter-bridge/sdk @counter-bridge/core @counter-bridge/provider-mongo
```

### Producer (your app)

```typescript
import { CounterClient } from '@counter-bridge/sdk';

const counter = new CounterClient({ redis: 'redis://localhost:6379' });

await counter.inc('v1:post:123:likes');
await counter.dec('v1:post:123:likes');
await counter.add('v1:post:123:views', 50);
```

### Consumer (background worker)

```typescript
import { CounterBridge } from '@counter-bridge/core';
import { MongoProvider } from '@counter-bridge/provider-mongo';

const bridge = new CounterBridge({
  redis: 'redis://localhost:6379',
  provider: new MongoProvider({ connection: mongoose.connection }),
});

bridge.on('flush', ({ scopeCount }) => console.log(`Flushed ${scopeCount} scopes`));
bridge.on('error', (err) => console.error(err));

await bridge.start();
```

### Reading counters

```typescript
// Direct read
const likes = await bridge.get('v1:post:123:likes');

// Batch read
const counters = await bridge.getBatch([
  'v1:post:123:likes',
  'v1:post:123:views',
]);
```

### Mongoose plugin

```typescript
import { counterPlugin, counterBridge } from '@counter-bridge/provider-mongo';

// Initialize the write client (once at app startup)
counterBridge.setup({ redisUrl: 'redis://localhost:6379' });

PostSchema.plugin(counterPlugin, {
  fields: ['likes', 'views', 'shares'],
  provider: new MongoProvider(),
});

// Write methods (push events to Redis Stream)
const post = await Post.findById(id);
await post.inc('likes');
await post.dec('likes');
await post.add('views', 50);

// Read methods (read from MongoDB)
const likes = await post.getCounter('likes');
const all = await post.getCounters(); // { likes: 42, views: 1337, shares: 7 }

// Hydrate arrays
const posts = await Post.find().limit(20);
const withCounters = await Post.withCounters(posts);
// [{ ...post, counters: { likes: 42, views: 1337, shares: 7 } }, ...]

// Cleanup on shutdown
await counterBridge.shutdown();
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for full Mermaid diagrams.

```
┌─────────────────────┐     ┌─────────────────────┐
│   @counter-bridge/   │     │   @counter-bridge/   │
│        sdk           │     │   provider-mongo     │
│  CounterClient       │     │   counterPlugin      │
│  (standalone)        │     │   inc/dec/add via    │
│                      │     │   global setup()     │
└──────────┬──────────┘     └──────────┬──────────┘
           │ XADD MAXLEN ~100k         │
           ├───────────────────────────┘
           ▼
┌─────────────────────┐
│   Redis Stream       │   counter-bridge:events
│   Consumer Group     │   counter-bridge-group
└──────────┬──────────┘
           │ XREADGROUP BLOCK
           ▼
┌─────────────────────┐
│   @counter-bridge/   │
│       core           │   CounterBridge — consumer + aggregator
│                      │
│  ┌───────────────┐   │   Aggregator folds deltas in-memory:
│  │  Aggregator   │   │   Map<scope, netDelta>
│  │  +1,+1,-1 → 1 │   │
│  └───────┬───────┘   │
│          │ drain()    │   Flush on timer (500ms) or batch size (1000)
│          ▼           │
│  ┌───────────────┐   │
│  │ flush → XACK  │   │   ACK only after provider.flush() succeeds
│  └───────┬───────┘   │
└──────────┼──────────┘
           │ provider.flush(batch)
           ▼
┌─────────────────────┐
│  ICounterProvider    │   Pluggable interface: flush() + get()
│  ┌───────────────┐   │
│  │ MongoProvider  │   │   bulkWrite with $inc, handles partial failures
│  └───────────────┘   │
│  ┌───────────────┐   │
│  │ YourProvider   │   │   Implement flush() and get() for any backend
│  └───────────────┘   │
└─────────────────────┘
```

## Custom Provider

Implement `ICounterProvider` to support any database:

```typescript
import { ICounterProvider, FlushResult } from '@counter-bridge/types';

class PostgresProvider implements ICounterProvider {
  async flush(batch: Map<string, number>): Promise<FlushResult | void> {
    // INSERT ... ON CONFLICT DO UPDATE SET value = value + $delta
  }

  async get(scope: string): Promise<number> {
    // SELECT value FROM counters WHERE scope = $1
    return 0;
  }

  // Optional
  async getBatch(scopes: string[]): Promise<Map<string, number>> { ... }
  async initialize(): Promise<void> { ... }
  async close(): Promise<void> { ... }
  async delete(scope: string): Promise<void> { ... }
}
```

Providers can return `{ failed: Map<scope, delta> }` from `flush()` for partial failure handling — only the failed scopes get retried.

## Configuration

### CounterClient (SDK)

| Option | Default | Description |
|---|---|---|
| `redis` | *required* | Redis URL or ioredis instance |
| `streamKey` | `counter-bridge:events` | Redis Stream key |
| `maxStreamLength` | `100000` | Approximate MAXLEN trim (0 to disable) |

### CounterBridge (Core)

| Option | Default | Description |
|---|---|---|
| `redis` | *required* | Redis URL or ioredis instance |
| `provider` | *required* | `ICounterProvider` implementation |
| `streamKey` | `counter-bridge:events` | Redis Stream key |
| `consumerGroup` | `counter-bridge-group` | Consumer group name |
| `consumerId` | auto-generated | Unique consumer ID |
| `batching.maxWaitMs` | `500` | Flush timer interval (ms) |
| `batching.maxMessages` | `1000` | Batch size threshold |

### MongoProvider

| Option | Default | Description |
|---|---|---|
| `connection` | default mongoose | Mongoose connection |
| `collectionName` | `counters` | MongoDB collection name |

## Events

`CounterBridge` extends `EventEmitter`:

```typescript
bridge.on('started', () => {});
bridge.on('stopped', () => {});
bridge.on('flush', ({ scopeCount, flushNumber }) => {});
bridge.on('recovery', ({ messageCount }) => {});  // PEL recovery on startup
bridge.on('error', (err) => {});
bridge.on('warn', ({ message, ...details }) => {}); // malformed events, partial failures
```

## Packages

| Package | Description |
|---|---|
| `@counter-bridge/types` | Shared TypeScript interfaces |
| `@counter-bridge/core` | Redis Stream consumer + in-memory aggregator |
| `@counter-bridge/sdk` | Lightweight XADD producer client |
| `@counter-bridge/provider-mongo` | MongoDB provider + Mongoose plugin (read & write) |
| `@counter-bridge/consumer` | Standalone consumer service (Docker + Helm) |

## Deployment

### Docker

```bash
docker build -f packages/consumer/Dockerfile -t counter-bridge:latest .

docker run \
  -e COUNTER_BRIDGE_REDIS_URL=redis://redis:6379 \
  -e COUNTER_BRIDGE_MONGODB_URI=mongodb://mongo:27017/counter-bridge \
  counter-bridge:latest
```

### Helm

```bash
helm install counter-bridge packages/consumer/helm/counter-bridge \
  --set config.redis.url=redis://redis:6379 \
  --set config.mongodb.uri=mongodb://mongo:27017/counter-bridge
```

With existing secrets:

```bash
# Create a secret with sensitive values
kubectl create secret generic counter-bridge-secrets \
  --from-literal=COUNTER_BRIDGE_REDIS_URL=redis://redis:6379 \
  --from-literal=COUNTER_BRIDGE_MONGODB_URI=mongodb://mongo:27017/counter-bridge

helm install counter-bridge packages/consumer/helm/counter-bridge \
  --set existingSecret=counter-bridge-secrets
```

Each pod gets a unique `COUNTER_BRIDGE_STREAM_CONSUMER_ID` from its pod name, so you can safely scale replicas.

### Configuration

The consumer service loads config from YAML (default `/etc/counter-bridge/config.yaml`) with environment variable overrides. See `packages/consumer/config/counter-bridge.yaml` for an example.

| Env Variable | Override |
|---|---|
| `COUNTER_BRIDGE_REDIS_URL` | `redis.url` |
| `COUNTER_BRIDGE_MONGODB_URI` | `mongodb.uri` |
| `COUNTER_BRIDGE_MONGODB_COLLECTION` | `mongodb.collectionName` |
| `COUNTER_BRIDGE_STREAM_KEY` | `stream.key` |
| `COUNTER_BRIDGE_STREAM_CONSUMER_GROUP` | `stream.consumerGroup` |
| `COUNTER_BRIDGE_STREAM_CONSUMER_ID` | `stream.consumerId` |
| `COUNTER_BRIDGE_BATCHING_MAX_WAIT_MS` | `batching.maxWaitMs` |
| `COUNTER_BRIDGE_BATCHING_MAX_MESSAGES` | `batching.maxMessages` |
| `COUNTER_BRIDGE_LOG_LEVEL` | `logging.level` |
| `COUNTER_BRIDGE_HEALTH_ENABLED` | `health.enabled` |
| `COUNTER_BRIDGE_HEALTH_PORT` | `health.port` |

## Development

```bash
npm install
npm run build     # Build all packages (Turborepo)
npm run test      # Run all tests
npm run dev       # Build in watch mode
```

## License

MIT
