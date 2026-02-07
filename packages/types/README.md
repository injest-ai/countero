# @counter-bridge/types

Shared TypeScript interfaces for CounterBridge's pluggable architecture.

## Core Interface: `ICounterProvider`

Every persistence backend must implement this interface:

```typescript
interface ICounterProvider {
  flush(batch: Map<string, number>): Promise<void>;
  get(scope: string): Promise<number>;
  getBatch?(scopes: string[]): Promise<Map<string, number>>;
  initialize?(): Promise<void>;
  close?(): Promise<void>;
}
```

## Example: Custom SQLite Provider

```typescript
import { ICounterProvider } from '@counter-bridge/types';
import Database from 'better-sqlite3';

export class SQLiteProvider implements ICounterProvider {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        scope TEXT PRIMARY KEY,
        value INTEGER DEFAULT 0
      )
    `);
  }

  async flush(batch: Map<string, number>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO counters (scope, value)
      VALUES (?, ?)
      ON CONFLICT(scope) DO UPDATE SET value = value + excluded.value
    `);

    const transaction = this.db.transaction(() => {
      for (const [scope, delta] of batch) {
        stmt.run(scope, delta);
      }
    });

    transaction();
  }

  async get(scope: string): Promise<number> {
    const row = this.db.prepare('SELECT value FROM counters WHERE scope = ?').get(scope);
    return (row as any)?.value || 0;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
```

## Usage

```typescript
import { CounterBridge } from '@counter-bridge/core';
import { SQLiteProvider } from './sqlite-provider';

const bridge = new CounterBridge({
  redis: 'redis://localhost:6379',
  provider: new SQLiteProvider('./counters.db'),
});

await bridge.start();
```

## Design Principles

1. **Minimal Surface Area:** Only two required methods (`flush` + `get`)
2. **Batch-First:** The `flush` API encourages bulk operations
3. **Async by Default:** All methods return Promises for I/O flexibility
4. **Optional Optimizations:** Providers can implement `getBatch` for faster reads

## Next Steps

See reference implementations:
- `@counter-bridge/provider-mongo` - MongoDB/Mongoose
- `@counter-bridge/provider-postgres` - PostgreSQL (coming soon)
