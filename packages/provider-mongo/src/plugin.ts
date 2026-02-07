import { Schema } from 'mongoose';
import type { ICounterProvider, ScopeMetadata } from '@counter-bridge/types';
import { MongoProvider } from './provider';
import { getClient } from './setup';

export interface CounterPluginOptions {
  /** Counter fields to add (e.g., ['likes', 'views']). */
  fields: string[];
  /** Scope prefix (e.g., 'v1:post'). Defaults to model name. */
  scopePrefix?: string;
  /** Default provider instance. If omitted, creates a new MongoProvider(). */
  provider?: ICounterProvider;
}

/**
 * Mongoose plugin that adds counter-aware methods to any schema.
 *
 * Usage:
 * ```ts
 * const provider = new MongoProvider();
 * PostSchema.plugin(counterPlugin, { fields: ['likes', 'views'], provider });
 *
 * const post = await Post.findById(id);
 * const likes = await post.getCounter('likes');
 * ```
 */
export function counterPlugin(schema: Schema, options: CounterPluginOptions): void {
  const { fields, scopePrefix, provider: defaultProvider } = options;
  const fieldSet = new Set(fields);

  const getProvider = (override?: ICounterProvider): ICounterProvider =>
    override ?? defaultProvider ?? new MongoProvider();

  /**
   * Build the scope string for a counter field on this document.
   * Format: "v1:{model}:{id}:{field}"
   */
  schema.methods.counterScope = function (field: string): string {
    if (!fieldSet.has(field)) {
      throw new Error(
        `Unknown counter field "${field}". Declared fields: [${fields.join(', ')}]`
      );
    }
    const prefix = scopePrefix ?? (this.constructor as any).modelName?.toLowerCase() ?? 'unknown';
    return `v1:${prefix}:${this._id}:${field}`;
  };

  /**
   * Increment a counter field by 1 via the SDK (produces to Redis Stream).
   */
  schema.methods.inc = async function (field: string, metadata?: ScopeMetadata): Promise<void> {
    const client = getClient();
    await client.inc(this.counterScope(field), metadata);
  };

  /**
   * Decrement a counter field by 1 via the SDK (produces to Redis Stream).
   */
  schema.methods.dec = async function (field: string, metadata?: ScopeMetadata): Promise<void> {
    const client = getClient();
    await client.dec(this.counterScope(field), metadata);
  };

  /**
   * Add an arbitrary delta to a counter field via the SDK (produces to Redis Stream).
   */
  schema.methods.add = async function (field: string, delta: number, metadata?: ScopeMetadata): Promise<void> {
    const client = getClient();
    await client.add(this.counterScope(field), delta, metadata);
  };

  /**
   * Get the current persistent value of a counter field.
   */
  schema.methods.getCounter = async function (
    field: string,
    provider?: ICounterProvider
  ): Promise<number> {
    return getProvider(provider).get(this.counterScope(field));
  };

  /**
   * Get all counter values for this document.
   */
  schema.methods.getCounters = async function (
    provider?: ICounterProvider
  ): Promise<Record<string, number>> {
    const p = getProvider(provider);
    const scopes = fields.map((f) => this.counterScope(f));

    let values: Map<string, number>;
    if (p.getBatch) {
      values = await p.getBatch(scopes);
    } else {
      const entries = await Promise.all(
        scopes.map(async (s) => [s, await p.get(s)] as const)
      );
      values = new Map(entries);
    }

    const result: Record<string, number> = {};
    for (const field of fields) {
      result[field] = values.get(this.counterScope(field)) ?? 0;
    }
    return result;
  };

  /**
   * Static: hydrate counter values onto an array of documents.
   * Documents must be Mongoose documents (not .lean() results).
   */
  schema.statics.withCounters = async function (
    docs: any[],
    counterFields?: string[],
    provider?: ICounterProvider
  ): Promise<any[]> {
    if (docs.length === 0) return [];

    const fieldsToFetch = counterFields ?? fields;
    const p = getProvider(provider);

    // Collect all scopes
    const allScopes: string[] = [];
    for (const doc of docs) {
      for (const field of fieldsToFetch) {
        allScopes.push(doc.counterScope(field));
      }
    }

    let values: Map<string, number>;
    if (p.getBatch) {
      values = await p.getBatch(allScopes);
    } else {
      const entries = await Promise.all(
        allScopes.map(async (s) => [s, await p.get(s)] as const)
      );
      values = new Map(entries);
    }

    return docs.map((doc) => {
      const counters: Record<string, number> = {};
      for (const field of fieldsToFetch) {
        counters[field] = values.get(doc.counterScope(field)) ?? 0;
      }
      return { ...doc.toObject(), counters };
    });
  };
}
