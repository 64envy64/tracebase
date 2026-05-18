/**
 * Portable Float32 embedding codec — explicit little-endian, magic-byte
 * versioned. Replaces the pre-May-2026 `Buffer.from(Float32Array.buffer)`
 * round-trip used by both V1 (`store.ts:971-983`) and V2
 * (`block-store.ts:2899-2993`).
 *
 * Why this exists
 * ---------------
 * The previous codec relied on:
 *   1. Node's `Buffer` aliasing the underlying `ArrayBuffer` of a typed
 *      array, AND
 *   2. The host architecture being little-endian.
 *
 * (1) is a Node internal detail subject to change across major versions
 * (`Buffer.from(Float32Array.buffer)` returns a Buffer view into the same
 * memory, but the contract is loose — `Uint8Array.buffer` aliasing
 * semantics have shifted before, and any future `Buffer` reimplementation
 * could break round-trip silently). (2) happens to be true on every
 * machine TraceBase has shipped on so far, but big-endian SQLite imports
 * (rare but legal) would silently corrupt every vector.
 *
 * Audit issue #6 flagged this as fragile. PR 3 of the May-2026
 * modernization fixes it with an explicit byte-level codec.
 *
 * Wire format
 * -----------
 * Every encoded buffer starts with a 4-byte header:
 *   bytes 0..2  = `'T'`, `'B'`, `'F'` (magic, 0x54 0x42 0x46)
 *   byte 3      = format version (currently 0x01)
 *
 * Then `n` little-endian Float32 values, where `n = (buf.length - 4) / 4`.
 *
 * Legacy buffers written by the old `Buffer.from(typedArray.buffer)`
 * codec have NO magic header — `decodeFloat32` detects this and falls
 * back to native-endian parsing for one-shot reads. The v15→v16 migration
 * then rewrites those rows in the canonical LE format.
 *
 * Test coverage lives in `tests/core/embedding-codec.test.ts`.
 */

/** Magic byte prefix on every new-format embedding. */
export const EMBEDDING_MAGIC_T = 0x54; // 'T'
export const EMBEDDING_MAGIC_B = 0x42; // 'B'
export const EMBEDDING_MAGIC_F = 0x46; // 'F'
export const EMBEDDING_VERSION = 0x01;
const HEADER_LEN = 4;

/** Encode a number array to a LE-Float32 Buffer with the new magic header. */
export function encodeFloat32LE(values: ArrayLike<number>): Buffer {
  const n = values.length;
  const buf = Buffer.allocUnsafe(HEADER_LEN + n * 4);
  buf[0] = EMBEDDING_MAGIC_T;
  buf[1] = EMBEDDING_MAGIC_B;
  buf[2] = EMBEDDING_MAGIC_F;
  buf[3] = EMBEDDING_VERSION;
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(values[i]!, HEADER_LEN + i * 4);
  }
  return buf;
}

/**
 * Decode an embedding Buffer into a `number[]`.
 *
 * Branches on the magic header:
 *   - Header present + version known → LE float32 read.
 *   - No header (legacy v15 buffer)  → native-endian read via the old
 *     `Buffer.from(Float32Array.buffer)` aliasing path. On every machine
 *     TraceBase has shipped on this is also LE, so the math agrees; the
 *     v15→v16 migration backfills the header so future reads land on
 *     the new branch.
 */
export function decodeFloat32(buf: Buffer): number[] {
  if (hasMagicHeader(buf)) {
    const n = (buf.length - HEADER_LEN) / 4;
    const out: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = buf.readFloatLE(HEADER_LEN + i * 4);
    }
    return out;
  }
  // Legacy fallback — native-endian read via typed-array aliasing.
  const f32 = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  return Array.from(f32);
}

/** Return true if `buf` carries the v16 magic header. */
export function hasMagicHeader(buf: Buffer): boolean {
  return (
    buf.length >= HEADER_LEN &&
    buf[0] === EMBEDDING_MAGIC_T &&
    buf[1] === EMBEDDING_MAGIC_B &&
    buf[2] === EMBEDDING_MAGIC_F &&
    buf[3] === EMBEDDING_VERSION
  );
}

/**
 * Re-encode a legacy buffer to the canonical LE format. Idempotent —
 * already-canonical buffers are returned as-is. Used by the v15→v16
 * migration to backfill embeddings written by the old codec.
 */
export function ensureCanonical(buf: Buffer): Buffer {
  if (hasMagicHeader(buf)) return buf;
  return encodeFloat32LE(decodeFloat32(buf));
}
