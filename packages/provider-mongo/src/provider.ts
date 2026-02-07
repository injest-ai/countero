import mongoose, { Model } from 'mongoose';
import type { ICounterProvider, FlushResult } from '@counter-bridge/types';
import { ICounterDocument, getCounterModel } from './schema';

export interface MongoProviderConfig {
  /** Existing Mongoose connection. If omitted, uses the default connection. */
  connection?: mongoose.Connection;
  /** Collection name for counter documents. Default: "counters". */
  collectionName?: string;
}

/**
 * MongoDB persistence provider for CounterBridge.
 *
 * Uses Mongoose's `bulkWrite` with `$inc` to efficiently flush
 * aggregated deltas in a single round-trip. Handles partial failures
 * by inspecting BulkWriteError results.
 */
export class MongoProvider implements ICounterProvider {
  private model: Model<ICounterDocument>;

  constructor(config: MongoProviderConfig = {}) {
    this.model = getCounterModel(config.connection, config.collectionName);
  }

  /**
   * Flush aggregated deltas to MongoDB using a single bulkWrite.
   * Each scope becomes an upsert operation with $inc.
   *
   * On partial failure, returns a FlushResult with only the failed scopes
   * so the core retries them instead of the entire batch.
   */
  async flush(batch: Map<string, number>): Promise<FlushResult | void> {
    if (batch.size === 0) return;

    const scopes = Array.from(batch.keys());
    const ops = Array.from(batch.entries()).map(([scope, delta]) => ({
      updateOne: {
        filter: { scope },
        update: {
          $inc: { value: delta },
          $setOnInsert: { scope },
        },
        upsert: true,
      },
    }));

    try {
      await this.model.bulkWrite(ops, { ordered: false });
    } catch (err: any) {
      // BulkWriteError contains results for each op — some may have succeeded
      if (err.name === 'MongoBulkWriteError' && err.result) {
        const writeErrors: { index: number }[] = err.result?.getWriteErrors?.() ?? err.writeErrors ?? [];
        if (writeErrors.length > 0 && writeErrors.length < ops.length) {
          // Partial failure: only retry the failed scopes
          const failedIndexes = new Set(writeErrors.map((e) => e.index));
          const failed = new Map<string, number>();
          for (const idx of failedIndexes) {
            const scope = scopes[idx];
            failed.set(scope, batch.get(scope)!);
          }
          return { failed };
        }
      }
      // Total failure or unknown error shape — rethrow for full retry
      throw err;
    }
  }

  /** Retrieve the current value for a single scope. */
  async get(scope: string): Promise<number> {
    const doc = await this.model.findOne({ scope }).select('value').lean();
    return doc?.value ?? 0;
  }

  /** Batch-read multiple scopes in one query. */
  async getBatch(scopes: string[]): Promise<Map<string, number>> {
    const docs = await this.model
      .find({ scope: { $in: scopes } })
      .select('scope value')
      .lean();

    const result = new Map<string, number>();
    for (const scope of scopes) {
      result.set(scope, 0);
    }
    for (const doc of docs) {
      result.set(doc.scope, doc.value);
    }
    return result;
  }

  /** Delete a counter scope entirely. */
  async delete(scope: string): Promise<void> {
    await this.model.deleteOne({ scope });
  }

  async initialize(): Promise<void> {
    await this.model.ensureIndexes();
  }

  async close(): Promise<void> {
    // Provider doesn't own the connection — caller manages lifecycle
  }
}
