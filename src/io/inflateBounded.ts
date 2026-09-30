import { Unzlib } from 'fflate';

/** Small input steps bound temporary expansion; stop before retaining excess data. */
export function inflateBounded(bytes: Uint8Array, limit: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const stream = new Unzlib((chunk) => {
    size += chunk.length;
    if (size > limit) throw new Error('Compressed data exceeds the decoding memory limit');
    chunks.push(chunk);
  });
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    stream.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
