import { describe, it, expect } from 'vitest';
import { maxDepth, node } from './source';

describe('maxDepth', () => {
  it('returns 0 for an empty tree (null)', () => {
    expect(maxDepth(null)).toBe(0);
  });

  it('returns 1 for a tree with only the root node', () => {
    expect(maxDepth(node(1))).toBe(1);
  });

  it('returns 2 for a root with one child', () => {
    const tree = node(1, node(2));
    expect(maxDepth(tree)).toBe(2);
  });

  it('returns 3 for a balanced tree of depth 3', () => {
    const tree = node(
      1,
      node(2, node(4), node(5)),
      node(3, node(6), node(7))
    );
    expect(maxDepth(tree)).toBe(3);
  });

  it('returns correct depth for an unbalanced tree', () => {
    // right-skewed: 1 -> 2 -> 3 -> 4
    const tree = node(1, null, node(2, null, node(3, null, node(4))));
    expect(maxDepth(tree)).toBe(4);
  });
});
