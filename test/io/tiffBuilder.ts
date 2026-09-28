/**
 * Penyusun TIFF kecil untuk test deteksi: header + satu IFD0 (dan opsional
 * satu SubIFD). Hanya tipe SHORT (3) dan LONG (4); nilai <= 4 byte ditaruh
 * inline, sisanya di belakang IFD. Tidak ada data gambar -- `detectFormat`
 * hanya membaca tag.
 */
export interface Entry { tag: number; type: 3 | 4; values: number[] }

export function buildTiff(ifd0: Entry[], opts: { bigEndian?: boolean; subIfd?: Entry[] } = {}): Uint8Array {
  const le = !opts.bigEndian;
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const extraSize = (entries: Entry[]) =>
    entries.reduce((s, e) => s + (e.values.length * (e.type === 3 ? 2 : 4) > 4 ? e.values.length * 4 : 0), 0);

  const main = [...ifd0];
  if (opts.subIfd) main.push({ tag: 330, type: 4, values: [0] });
  main.sort((a, b) => a.tag - b.tag);

  const ifd0At = 8;
  const extra0At = ifd0At + ifdSize(main.length);
  const subAt = extra0At + extraSize(main);
  const sub = opts.subIfd ? [...opts.subIfd].sort((a, b) => a.tag - b.tag) : [];
  const total = subAt + (sub.length ? ifdSize(sub.length) + extraSize(sub) : 0);

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  buf.set(le ? [0x49, 0x49, 0x2a, 0x00] : [0x4d, 0x4d, 0x00, 0x2a]);
  view.setUint32(4, ifd0At, le);

  const writeIfd = (at: number, entries: Entry[], extraAt: number) => {
    view.setUint16(at, entries.length, le);
    let extra = extraAt;
    entries.forEach((e, i) => {
      const values = e.tag === 330 && opts.subIfd ? [subAt] : e.values;
      const p = at + 2 + i * 12;
      view.setUint16(p, e.tag, le);
      view.setUint16(p + 2, e.type, le);
      view.setUint32(p + 4, values.length, le);
      const size = e.type === 3 ? 2 : 4;
      let dst = p + 8;
      if (values.length * size > 4) {
        view.setUint32(p + 8, extra, le);
        dst = extra;
        extra += values.length * 4;
      }
      values.forEach((v, k) => (size === 2 ? view.setUint16(dst + k * 2, v, le) : view.setUint32(dst + k * 4, v, le)));
    });
    view.setUint32(at + 2 + entries.length * 12, 0, le);
  };
  writeIfd(ifd0At, main, extra0At);
  if (sub.length) writeIfd(subAt, sub, subAt + ifdSize(sub.length));
  return buf;
}

/** Tag minimum TIFF RGB 8-bit. */
export const RGB_TAGS: Entry[] = [
  { tag: 256, type: 4, values: [4] },
  { tag: 257, type: 4, values: [4] },
  { tag: 258, type: 3, values: [8, 8, 8] },
  { tag: 259, type: 3, values: [1] },
  { tag: 262, type: 3, values: [2] },
];
