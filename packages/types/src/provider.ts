/**
 * Result of a flush operation. Providers that can detect partial failures
 * should return the failed scopes so the core can retry only those.
 */
export interface FlushResult {
  /** Scopes that failed to persist, with their original deltas. */
  failed?: Map<string, number>;
}

/**
 * Core abstraction for persistence backends.
 * All database-specific implementations must conform to this interface.
 */
export interface ICounterProvider {
  /**
   * Persist a batch of aggregated counter deltas.
   *
   * Returns void on full success. Optionally returns a FlushResult
   * with a `failed` map for partial failures, so the core retries
   * only the failed scopes instead of the entire batch.
   *
   * @param batch - Map of scope keys to their net change values
   * @example
   * await provider.flush(new Map([
   *   ['v1:post:123:likes', 5],
   *   ['v1:post:456:views', -2]
   * ]))
   */
  flush(batch: Map<string, number>): Promise<FlushResult | void>;

  /**
   * Retrieve the current persisted value for a given scope.
   *
   * @param scope - The unique counter identifier
   * @returns The current count, or 0 if not found
   */
  get(scope: string): Promise<number>;

  /**
   * Optional: Batch retrieval for multiple scopes.
   * Providers can optimize this with native bulk reads.
   *
   * @param scopes - Array of scope identifiers
   * @returns Map of scopes to their current values
   */
  getBatch?(scopes: string[]): Promise<Map<string, number>>;

  /**
   * Optional: Delete a counter scope entirely.
   */
  delete?(scope: string): Promise<void>;

  /**
   * Optional: Initialize provider resources (connections, schemas, etc.)
   */
  initialize?(): Promise<void>;

  /**
   * Optional: Clean up resources on shutdown
   */
  close?(): Promise<void>;
}

/**
 * Metadata that can be attached to a scope for routing/partitioning.
 * Useful for providers that need to distribute data across tables/collections.
 */
export interface ScopeMetadata {
  /** Logical entity type (e.g., 'post', 'user') */
  model?: string;

  /** Tenant/organization ID for multi-tenant systems */
  tenantId?: string;

  /** Custom tags for provider-specific routing */
  tags?: Record<string, string>;
}
