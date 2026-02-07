import { CounterEvent } from '@counter-bridge/types';

/**
 * In-memory aggregator that folds individual counter events into net deltas.
 *
 * Example: three events for "post_123" (+1, +1, -1) fold into net +1.
 */
export class Aggregator {
  private deltas = new Map<string, number>();
  private count = 0;

  /** Add a single event to the aggregation window. */
  add(event: CounterEvent): void {
    const current = this.deltas.get(event.scope) ?? 0;
    this.deltas.set(event.scope, current + event.delta);
    this.count++;
  }

  /** Returns the number of events accumulated. */
  get size(): number {
    return this.count;
  }

  /** Returns the number of unique scopes. */
  get scopeCount(): number {
    return this.deltas.size;
  }

  /**
   * Drain the aggregator and return the folded deltas.
   * Resets internal state for the next window.
   */
  drain(): Map<string, number> {
    const batch = this.deltas;
    this.deltas = new Map();
    this.count = 0;
    return batch;
  }
}
