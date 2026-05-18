import { describe, it, expect } from "vitest";
import {
  encodeFloat32LE,
  decodeFloat32,
  hasMagicHeader,
  ensureCanonical,
  EMBEDDING_MAGIC_T,
  EMBEDDING_MAGIC_B,
  EMBEDDING_MAGIC_F,
  EMBEDDING_VERSION,
} from "../../src/core/embedding-codec.js";

// Helper: encode using the LEGACY codec (pre-May-2026 PR 3) so we can
// verify backward-compat decode. This mirrors the original `Buffer.from
// (Float32Array.buffer)` aliasing path bit-for-bit.
function legacyEncode(arr: number[]): Buffer {
  const f32 = new Float32Array(arr);
  return Buffer.from(f32.buffer);
}

describe("embedding-codec (May-2026 PR 3, audit #6)", () => {
  it("round-trips a vector with the new LE-explicit codec", () => {
    const v = [0.5, -1.25, 3.14159, 0, 1e-6, -1e6, NaN, Infinity, -Infinity];
    const buf = encodeFloat32LE(v);
    const out = decodeFloat32(buf);
    expect(out.length).toBe(v.length);
    // Float32 has limited precision; compare with tolerance for finite
    // values, exact identity for special values.
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[1]).toBeCloseTo(-1.25, 6);
    expect(out[2]).toBeCloseTo(3.14159, 4);
    expect(out[3]).toBe(0);
    expect(out[4]).toBeCloseTo(1e-6, 9);
    expect(out[5]).toBeCloseTo(-1e6, 0);
    expect(Number.isNaN(out[6])).toBe(true);
    expect(out[7]).toBe(Infinity);
    expect(out[8]).toBe(-Infinity);
  });

  it("encoded buffer starts with the canonical magic header", () => {
    const buf = encodeFloat32LE([1, 2, 3]);
    expect(buf[0]).toBe(EMBEDDING_MAGIC_T);
    expect(buf[1]).toBe(EMBEDDING_MAGIC_B);
    expect(buf[2]).toBe(EMBEDDING_MAGIC_F);
    expect(buf[3]).toBe(EMBEDDING_VERSION);
    // Header + 3 floats × 4 bytes
    expect(buf.length).toBe(4 + 3 * 4);
  });

  it("hasMagicHeader recognises new-format buffers and rejects legacy ones", () => {
    expect(hasMagicHeader(encodeFloat32LE([1, 2, 3]))).toBe(true);
    expect(hasMagicHeader(legacyEncode([1, 2, 3]))).toBe(false);
    expect(hasMagicHeader(Buffer.alloc(0))).toBe(false);
    expect(hasMagicHeader(Buffer.from([1, 2, 3]))).toBe(false);
  });

  it("decodeFloat32 round-trips a LEGACY (no-header) buffer on a LE host", () => {
    // Every CI machine TraceBase ships on is little-endian, so the
    // legacy native-endian aliasing decode produces the same values as
    // the new LE-explicit codec. This test pins that invariant.
    const v = [0.5, -1.25, 3.14159, 0, 42.0];
    const legacyBuf = legacyEncode(v);
    const out = decodeFloat32(legacyBuf);
    for (let i = 0; i < v.length; i++) {
      expect(out[i]).toBeCloseTo(v[i]!, 5);
    }
  });

  it("ensureCanonical promotes a legacy buffer to the new format", () => {
    const v = [1, 2, 3, 4, 5];
    const legacy = legacyEncode(v);
    expect(hasMagicHeader(legacy)).toBe(false);

    const promoted = ensureCanonical(legacy);
    expect(hasMagicHeader(promoted)).toBe(true);

    const out = decodeFloat32(promoted);
    for (let i = 0; i < v.length; i++) {
      expect(out[i]).toBeCloseTo(v[i]!, 5);
    }
  });

  it("ensureCanonical is a no-op on already-canonical buffers (returns same instance)", () => {
    const buf = encodeFloat32LE([1, 2, 3]);
    expect(ensureCanonical(buf)).toBe(buf);
  });

  it("decoded values are explicitly little-endian regardless of host", () => {
    // Manually construct a known-LE Float32 buffer for value 1.0
    // (IEEE-754: 0x00 0x00 0x80 0x3F in LE order).
    const buf = Buffer.alloc(4 + 4);
    buf[0] = EMBEDDING_MAGIC_T;
    buf[1] = EMBEDDING_MAGIC_B;
    buf[2] = EMBEDDING_MAGIC_F;
    buf[3] = EMBEDDING_VERSION;
    buf[4] = 0x00;
    buf[5] = 0x00;
    buf[6] = 0x80;
    buf[7] = 0x3f;
    expect(decodeFloat32(buf)).toEqual([1.0]);
  });

  it("empty vector round-trips correctly (header-only payload)", () => {
    const buf = encodeFloat32LE([]);
    expect(buf.length).toBe(4); // header only
    expect(hasMagicHeader(buf)).toBe(true);
    expect(decodeFloat32(buf)).toEqual([]);
  });
});
