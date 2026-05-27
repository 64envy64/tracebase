/**
 * Deep clones a value, handling nested objects, arrays, Dates,
 * and circular references.
 */
export function deepClone<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }

  const existing = seen.get(value as object);
  if (existing !== undefined) {
    return existing as T;
  }

  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    seen.set(value as object, arr);
    for (const item of value) {
      arr.push(deepClone(item, seen));
    }
    return arr as unknown as T;
  }

  const result: Record<string, unknown> = {};
  seen.set(value as object, result);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    result[key] = deepClone((value as Record<string, unknown>)[key], seen);
  }

  return result as T;
}

/**
 * Deep equality check for two values.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (typeof a !== 'object' || typeof b !== 'object') return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;

  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
}
