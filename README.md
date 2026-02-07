# CounterBridge

High-throughput counter synchronization service. Aggregates increment/decrement events from a Redis Stream, folds them in-memory, and flushes batched deltas to any persistence backend.

```
App → post.inc('likes') → Redis Stream → Consumer Service → Aggregator → MongoDB
```

100k individual `+1` events become a single `$inc: { value: 100000 }` write.

## Why

Naive counter updates (`UPDATE posts SET likes = likes + 1`) under high concurrency create write contention, lock waits, and wasted IOPS. CounterBridge solves this by:

- **Decoupling writes** — producers fire-and-forget into a Redis Stream
- **Folding deltas** — the Aggregator collapses `[+1, +1, -1]` into `+1` before touching the database
- **Batching flushes** — one `bulkWrite` per window (default 500ms) instead of per-event
- **At-least-once delivery** — messages are only ACK'd after successful persistence; crashes recover from the PEL

## Quick Start

### 1. Install the plugin in your app

```bash
npm install @counter-bridge/provider-mongo
```

```typescript
import mongoose from 'mongoose';
import { counterPlugin, counterBridge, MongoProvider } from '@counter-bridge/provider-mongo';

// Initialize the write client once at app startup
counterBridge.setup({ redisUrl: 'redis://localhost:6379' });

// Add counters to any Mongoose schema
PostSchema.plugin(counterPlugin, {
  fields: ['likes', 'views', 'shares'],
  provider: new MongoProvider(),
});

// Write — fire-and-forget into Redis Stream
const post = await Post.findById(id);
await post.inc('likes');
await post.dec('likes');
await post.add('views', 50);

// Read — directly from MongoDB
const likes = await post.getCounter('likes');
const all = await post.getCounters(); // { likes: 42, views: 1337, shares: 7 }

// Hydrate arrays
const posts = await Post.find().limit(20);
const withCounters = await Post.withCounters(posts);
// [{ ...post, counters: { likes: 42, views: 1337, shares: 7 } }, ...]

// Cleanup on shutdown
await counterBridge.shutdown();
```

### 2. Deploy the consumer service

The consumer reads from the Redis Stream, aggregates deltas, and flushes to MongoDB. Deploy it as a standalone service:

```bash
# Docker
docker run ghcr.io/injest-ai/counter-bridge:latest \
  -e COUNTER_BRIDGE_REDIS_URL=redis://redis:6379 \
  -e COUNTER_BRIDGE_MONGODB_URI=mongodb://mongo:27017/myapp

# Or Helm
helm install counter-bridge packages/consumer/helm/counter-bridge \
  --set config.redis.url=redis://redis:6379 \
  --set config.mongodb.uri=mongodb://mongo:27017/myapp
```

See [Deployment](#deployment) for full configuration options.

## Architecture

See [docs/architecture.md](docs/architecture.md) for full Mermaid diagrams.

```
┌─────────────────────┐
│     Your App         │
│                      │
│  post.inc('likes')   │   Mongoose plugin writes to Redis Stream
│  post.getCounter()   │   Reads directly from MongoDB
└──────────┬──────────┘
           │ XADD (via counterBridge.setup())
           ▼
┌─────────────────────┐
│   Redis Stream       │   counter-bridge:events
│   Consumer Group     │   counter-bridge-group
└──────────┬──────────┘
           │ XREADGROUP BLOCK
           ▼
┌─────────────────────┐
│   Consumer Service   │   Standalone Docker/Helm deployment
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
│  MongoDB             │   bulkWrite with $inc per scope
│  counters collection │   Handles partial failures
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

### Plugin Setup

| Option | Default | Description |
|---|---|---|
| `redisUrl` | *required* | Redis connection URL |
| `streamKey` | `counter-bridge:events` | Redis Stream key |
| `maxStreamLength` | `100000` | Approximate MAXLEN trim (0 to disable) |

### Counter Plugin

| Option | Default | Description |
|---|---|---|
| `fields` | *required* | Counter field names (e.g., `['likes', 'views']`) |
| `scopePrefix` | model name | Scope prefix (e.g., `'v1:post'`) |
| `provider` | new MongoProvider() | `ICounterProvider` instance for reads |

### MongoProvider

| Option | Default | Description |
|---|---|---|
| `connection` | default mongoose | Mongoose connection |
| `collectionName` | `counters` | MongoDB collection name |

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
