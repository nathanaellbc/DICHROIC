/**
 * Tables derived only from colour-science constants (no stock, no photo):
 * built once per process, and on iOS saved by the host between launches
 * (`serializePrecomputed`/`loadPrecomputed`), since building them takes
 * seconds where JavaScriptCore has no JIT. The key holds every input.
 */
type Table = Float32Array | Float64Array;

const tables = new Map<string, Table>();
let changed = false;

export function precomputed<T extends Table>(key: string, build: () => T): T {
  const hit = tables.get(key);
  if (hit) return hit as T;
  const value = build();
  tables.set(key, value);
  changed = true;
  return value;
}

/** True once after new tables were built (the host then saves them). */
export function takePrecomputedChanged(): boolean {
  const was = changed;
  changed = false;
  return was;
}

/** Header (JSON, length-prefixed) followed by each table's bytes. */
export function serializePrecomputed(): ArrayBuffer {
  const entries = [...tables.entries()];
  let offset = 0;
  const index = entries.map(([key, data]) => {
    const item = { key, type: data instanceof Float64Array ? 'f64' : 'f32', offset, length: data.length };
    offset += data.byteLength;
    return item;
  });
  const header = new TextEncoder().encode(JSON.stringify(index));
  // Tables start 8-byte aligned so float64 views need no copy.
  const start = Math.ceil((4 + header.length) / 8) * 8;
  const out = new Uint8Array(start + offset);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  entries.forEach(([, data], i) => out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), start + index[i]!.offset));
  return out.buffer;
}

/** Restores saved tables; anything malformed is ignored (they are rebuilt). */
export function loadPrecomputed(buffer: ArrayBuffer): void {
  try {
    const length = new DataView(buffer).getUint32(0, true);
    const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as
      Array<{ key: string; type: 'f32' | 'f64'; offset: number; length: number }>;
    const start = Math.ceil((4 + length) / 8) * 8;
    for (const { key, type, offset, length: n } of index) {
      const bytes = buffer.slice(start + offset, start + offset + n * (type === 'f64' ? 8 : 4));
      tables.set(key, type === 'f64' ? new Float64Array(bytes) : new Float32Array(bytes));
    }
  } catch {
    // A damaged cache only costs the rebuild.
  }
}
