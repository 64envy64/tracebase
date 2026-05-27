import { describe, it, expect } from 'vitest';
import { processItems, saveRecords } from './source';

describe('processItems', () => {
  it('processes all items and returns results in order', async () => {
    const items = [1, 2, 3];
    const handler = async (n: number) => n * 10;

    const results = await processItems(items, handler);
    expect(results).toEqual([10, 20, 30]);
  });

  it('handles async handlers with varying delays', async () => {
    const items = ['a', 'b', 'c'];
    const handler = async (s: string) => {
      await new Promise((r) => setTimeout(r, 10));
      return s.toUpperCase();
    };

    const results = await processItems(items, handler);
    expect(results).toEqual(['A', 'B', 'C']);
  });

  it('returns an empty array for empty input', async () => {
    const results = await processItems([], async (x: number) => x);
    expect(results).toEqual([]);
  });
});

describe('saveRecords', () => {
  it('counts all successfully saved records', async () => {
    const records = ['rec1', 'rec2', 'rec3'];
    const saveFn = async (_r: string) => true;

    const count = await saveRecords(records, saveFn);
    expect(count).toBe(3);
  });

  it('counts only successful saves when some fail', async () => {
    const records = ['ok', 'fail', 'ok'];
    const saveFn = async (r: string) => {
      await new Promise((res) => setTimeout(res, 5));
      return r !== 'fail';
    };

    const count = await saveRecords(records, saveFn);
    expect(count).toBe(2);
  });
});
