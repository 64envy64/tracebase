export interface TreeNode {
  value: number;
  left: TreeNode | null;
  right: TreeNode | null;
}

/**
 * Creates a tree node.
 */
export function node(
  value: number,
  left: TreeNode | null = null,
  right: TreeNode | null = null
): TreeNode {
  return { value, left, right };
}

/**
 * Returns the maximum depth (number of nodes on the longest root-to-leaf path)
 * of a binary tree.
 *
 * A single root node has depth 1. An empty tree (null) has depth 0.
 */
export function maxDepth(root: TreeNode | null): number {
  if (!root) return 0;
  if (!root.left && !root.right) return 1;

  const leftDepth = maxDepth(root.left);
  const rightDepth = maxDepth(root.right);

  return 1 + Math.max(leftDepth, rightDepth);
}

/**
 * Returns the minimum depth (shortest root-to-leaf path).
 */
export function minDepth(root: TreeNode | null): number {
  if (!root) return 0;
  if (!root.left && !root.right) return 1;

  if (!root.left) return 1 + minDepth(root.right);
  if (!root.right) return 1 + minDepth(root.left);

  return 1 + Math.min(minDepth(root.left), minDepth(root.right));
}
