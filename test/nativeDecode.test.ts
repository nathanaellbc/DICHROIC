import { expect, it } from 'vitest';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { decodeRaw } from '../src/io/raw';
import { decodeImage } from '../src/io';
import { encodePng, encodeTiff16 } from '../src/io/encode';
import { buildIccProfile } from '../src/io/icc';
import { dcrawGammaCurve, invertDcrawCurve } from '../src/io/dcrawGamma';
import type { Manifest } from '../src/profiles/load';

it.skipIf(!process.env.DICHROIC_UPDATE_IOS_DECODE)('captures independent web decoder references and checks the native LibRaw probe', async () => {
  const folder = 'mobile/assets/parity', cases = [];
  mkdirSync(folder, { recursive: true });
  const wasmBinary = new Uint8Array(readFileSync('node_modules/libraw-wasm/dist/libraw.wasm'));
  const curve = invertDcrawCurve(dcrawGammaCurve(0.45, 4.5, 2, 0x10000));
  for (const name of ['synthetic_rggb', 'synthetic_rggb_rot90']) {
    const file = `${name}.dng`, input = `test/fixtures/raw/${name}/input.dng`;
    copyFileSync(input, `${folder}/${file}`);
    const image = await decodeRaw(new Uint8Array(readFileSync(input)), file, { wasmBinary });
    if (process.env.DICHROIC_RAW_PROBE) {
      const output = `native/target/${name}.rgb16`;
      const info = JSON.parse(execFileSync(process.env.DICHROIC_RAW_PROBE, [input, output], { encoding: 'utf8' }));
      expect([info.width, info.height, info.channels, info.bits]).toEqual([image.width, image.height, 3, 16]);
      const bytes = readFileSync(output);
      let max = 0;
      for (let i = 0; i < image.width * image.height; i++) for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(Math.fround(curve[bytes.readUInt16BE(info.offset + (i * 3 + c) * 2)]! / 65535) - image.rgba[i * 4 + c]!));
      expect(max).toBeLessThanOrEqual(1e-5);
      console.log(`${file}: native LibRaw vs web maximum ${max}`);
    }
    writeFileSync(`${folder}/${file}.f32`, new Uint8Array(image.rgba.buffer));
    cases.push({ file, width: image.width, height: image.height, colorSpace: image.suggestedColorSpace, encoding: image.encoding, tolerance: 1e-5 });
  }
  const manifest = JSON.parse(readFileSync('public/data/manifest.json', 'utf8')) as Manifest;
  const pixels = Uint16Array.from({ length: 32 * 24 * 3 }, (_, i) => (i * 1537 + 73) % 65536);
  const icc = buildIccProfile(manifest.outputColorSpaces['Display P3']!, 'Display P3');
  for (const [file, bytes] of [['p3-16.png', encodePng(pixels, 32, 24, 16, { icc })], ['p3-16.tiff', encodeTiff16(pixels, 32, 24, { icc })]] as const) {
    writeFileSync(`${folder}/${file}`, bytes);
    const image = await decodeImage(bytes, file);
    writeFileSync(`${folder}/${file}.f32`, new Uint8Array(image.rgba.buffer));
    cases.push({ file, width: image.width, height: image.height, colorSpace: image.suggestedColorSpace, encoding: image.encoding, tolerance: 1e-7 });
  }
  writeFileSync(`${folder}/decode.json`, JSON.stringify(cases));
}, 120000);
