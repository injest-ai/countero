import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MongoProvider } from './provider';

// ─── Mock Mongoose Model ─────────────────────────────────────────────────────

const mockModel = {
  bulkWrite: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  findOne: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    }),
  }),
  find: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    }),
  }),
  deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  ensureIndexes: vi.fn().mockResolvedValue(undefined),
};

vi.mock('./schema', () => ({
  getCounterModel: vi.fn(() => mockModel),
}));

describe('MongoProvider', () => {
  let provider: MongoProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new MongoProvider();
  });

  describe('flush', () => {
    it('should skip bulkWrite when batch is empty', async () => {
      await provider.flush(new Map());
      expect(mockModel.bulkWrite).not.toHaveBeenCalled();
    });

    it('should call bulkWrite with $inc operations for each scope', async () => {
      const batch = new Map([
        ['post:1:likes', 5],
        ['post:2:views', 10],
      ]);

      await provider.flush(batch);

      expect(mockModel.bulkWrite).toHaveBeenCalledOnce();
      const [ops, options] = mockModel.bulkWrite.mock.calls[0];

      expect(ops).toHaveLength(2);
      expect(options).toEqual({ ordered: false });

      // Check first operation
      expect(ops[0].updateOne.filter).toEqual({ scope: 'post:1:likes' });
      expect(ops[0].updateOne.update.$inc).toEqual({ value: 5 });
      expect(ops[0].updateOne.upsert).toBe(true);

      // Check second operation
      expect(ops[1].updateOne.filter).toEqual({ scope: 'post:2:views' });
      expect(ops[1].updateOne.update.$inc).toEqual({ value: 10 });
    });

    it('should handle negative deltas (decrements)', async () => {
      const batch = new Map([['post:1:likes', -3]]);

      await provider.flush(batch);

      const [ops] = mockModel.bulkWrite.mock.calls[0];
      expect(ops[0].updateOne.update.$inc).toEqual({ value: -3 });
    });

    it('should not include manual $set updatedAt (uses schema timestamps)', async () => {
      const batch = new Map([['post:1:likes', 1]]);
      await provider.flush(batch);

      const [ops] = mockModel.bulkWrite.mock.calls[0];
      expect(ops[0].updateOne.update.$set).toBeUndefined();
    });

    it('should propagate total bulkWrite errors', async () => {
      mockModel.bulkWrite.mockRejectedValueOnce(new Error('Write failed'));
      const batch = new Map([['x', 1]]);
      await expect(provider.flush(batch)).rejects.toThrow('Write failed');
    });

    it('should return failed scopes on partial BulkWriteError', async () => {
      const partialError: any = new Error('Partial failure');
      partialError.name = 'MongoBulkWriteError';
      partialError.result = {
        getWriteErrors: () => [{ index: 1 }], // second op failed
      };
      mockModel.bulkWrite.mockRejectedValueOnce(partialError);

      const batch = new Map([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]);

      const result = await provider.flush(batch);
      expect(result).toBeDefined();
      expect(result!.failed!.size).toBe(1);
      expect(result!.failed!.get('b')).toBe(2); // only the failed scope
    });

    it('should rethrow when all ops fail in BulkWriteError', async () => {
      const totalError: any = new Error('All failed');
      totalError.name = 'MongoBulkWriteError';
      totalError.result = {
        getWriteErrors: () => [{ index: 0 }, { index: 1 }],
      };
      mockModel.bulkWrite.mockRejectedValueOnce(totalError);

      const batch = new Map([['a', 1], ['b', 2]]);
      await expect(provider.flush(batch)).rejects.toThrow('All failed');
    });
  });

  describe('get', () => {
    it('should return 0 when scope does not exist', async () => {
      const value = await provider.get('nonexistent');
      expect(value).toBe(0);
    });

    it('should return the stored value', async () => {
      mockModel.findOne.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue({ scope: 'post:1:likes', value: 42 }),
        }),
      });

      const value = await provider.get('post:1:likes');
      expect(value).toBe(42);
    });
  });

  describe('getBatch', () => {
    it('should return 0 for all scopes when none exist', async () => {
      const result = await provider.getBatch(['a', 'b', 'c']);
      expect(result.get('a')).toBe(0);
      expect(result.get('b')).toBe(0);
      expect(result.get('c')).toBe(0);
    });

    it('should return stored values and default missing to 0', async () => {
      mockModel.find.mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            { scope: 'a', value: 10 },
            { scope: 'c', value: 30 },
          ]),
        }),
      });

      const result = await provider.getBatch(['a', 'b', 'c']);
      expect(result.get('a')).toBe(10);
      expect(result.get('b')).toBe(0);
      expect(result.get('c')).toBe(30);
    });
  });

  describe('delete', () => {
    it('should delete a scope', async () => {
      await provider.delete('post:1:likes');
      expect(mockModel.deleteOne).toHaveBeenCalledWith({ scope: 'post:1:likes' });
    });
  });

  describe('initialize', () => {
    it('should call ensureIndexes', async () => {
      await provider.initialize();
      expect(mockModel.ensureIndexes).toHaveBeenCalledOnce();
    });
  });
});
