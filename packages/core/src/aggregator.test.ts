import { describe, it, expect } from 'vitest';
import { Aggregator } from './aggregator';

describe('Aggregator', () => {
  it('should accumulate deltas for a single scope', () => {
    const agg = new Aggregator();
    agg.add({ scope: 'post:1:likes', delta: 1 });
    agg.add({ scope: 'post:1:likes', delta: 1 });
    agg.add({ scope: 'post:1:likes', delta: 1 });

    const batch = agg.drain();
    expect(batch.get('post:1:likes')).toBe(3);
  });

  it('should fold increments and decrements into net delta', () => {
    const agg = new Aggregator();
    agg.add({ scope: 'post:1:likes', delta: 1 });
    agg.add({ scope: 'post:1:likes', delta: 1 });
    agg.add({ scope: 'post:1:likes', delta: -1 });

    const batch = agg.drain();
    expect(batch.get('post:1:likes')).toBe(1);
  });

  it('should handle multiple scopes independently', () => {
    const agg = new Aggregator();
    agg.add({ scope: 'post:1:likes', delta: 3 });
    agg.add({ scope: 'post:2:views', delta: 10 });
    agg.add({ scope: 'post:1:likes', delta: -1 });

    const batch = agg.drain();
    expect(batch.get('post:1:likes')).toBe(2);
    expect(batch.get('post:2:views')).toBe(10);
    expect(batch.size).toBe(2);
  });

  it('should track event count via size', () => {
    const agg = new Aggregator();
    expect(agg.size).toBe(0);

    agg.add({ scope: 'a', delta: 1 });
    agg.add({ scope: 'a', delta: 1 });
    agg.add({ scope: 'b', delta: 1 });
    expect(agg.size).toBe(3);
    expect(agg.scopeCount).toBe(2);
  });

  it('should reset state after drain', () => {
    const agg = new Aggregator();
    agg.add({ scope: 'x', delta: 5 });

    const batch1 = agg.drain();
    expect(batch1.get('x')).toBe(5);
    expect(agg.size).toBe(0);
    expect(agg.scopeCount).toBe(0);

    // New events after drain should start fresh
    agg.add({ scope: 'x', delta: 2 });
    const batch2 = agg.drain();
    expect(batch2.get('x')).toBe(2);
  });

  it('should handle net-zero deltas', () => {
    const agg = new Aggregator();
    agg.add({ scope: 'post:1:likes', delta: 5 });
    agg.add({ scope: 'post:1:likes', delta: -5 });

    const batch = agg.drain();
    expect(batch.get('post:1:likes')).toBe(0);
  });

  it('should handle negative-only deltas', () => {
    const agg = new Aggregator();
    agg.add({ scope: 'post:1:likes', delta: -3 });

    const batch = agg.drain();
    expect(batch.get('post:1:likes')).toBe(-3);
  });

  it('should return empty map when drained with no events', () => {
    const agg = new Aggregator();
    const batch = agg.drain();
    expect(batch.size).toBe(0);
  });

  it('should handle large batch sizes', () => {
    const agg = new Aggregator();
    for (let i = 0; i < 10_000; i++) {
      agg.add({ scope: `scope:${i % 100}`, delta: 1 });
    }

    expect(agg.size).toBe(10_000);
    expect(agg.scopeCount).toBe(100);

    const batch = agg.drain();
    // Each of 100 scopes got 100 increments
    for (let i = 0; i < 100; i++) {
      expect(batch.get(`scope:${i}`)).toBe(100);
    }
  });
});
