import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

await mkdir('native/target/oracle', {recursive: true});
const bundle = resolve('native/target/oracle/box.mjs');
await build({entryPoints: ['src/session/downscale.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm'});
const {boxDownscaleRegion} = await import(pathToFileURL(bundle).href);
const cases = [];
for (const [bits, channels, bigEndian, lookup] of [[8,4,false,false],[16,3,true,true],[16,4,false,false],[32,1,false,false],[32,4,true,false]]) {
  const sourceWidth = 17, sourceHeight = 13, byteOffset = 7;
  const bytes = new Uint8Array(byteOffset + sourceWidth * sourceHeight * channels * bits / 8);
  const view = new DataView(bytes.buffer), floats = new Float32Array(sourceWidth * sourceHeight * 4);
  for (let p = 0; p < sourceWidth * sourceHeight; p++) for (let c = 0; c < channels; c++) {
    const n = (p * channels + c) * 1777 % (bits === 8 ? 256 : 65536), at = byteOffset + (p * channels + c) * bits / 8;
    let value;
    if (bits === 8) {view.setUint8(at,n);value=Math.fround(n / 255);}
    else if (bits === 16) {view.setUint16(at,n,!bigEndian);value=Math.fround(lookup ? (n/65535)**2.2 : n/65535);}
    else {value=Math.fround((n/65535)*3-.5);view.setFloat32(at,value,!bigEndian);}
    floats[p*4+c]=value;
    if (channels === 1) {floats[p*4+1]=value;floats[p*4+2]=value;}
    if (channels !== 4) floats[p*4+3]=1;
  }
  for (const [outWidth,outHeight,x,y,width,height] of [[7,5,0,0,7,5],[9,11,2,3,4,5],[17,13,5,2,9,7],[31,24,21,17,10,7]]) {
    cases.push({name:`${bits}/${channels}/${bigEndian} ${outWidth}x${outHeight}`,bytes:Array.from(bytes),lookup,
      spec:{sourceWidth,sourceHeight,bits,channels,byteOffset,bigEndian,outWidth,outHeight,x,y,width,height},
      expected:Array.from(boxDownscaleRegion(floats,sourceWidth,sourceHeight,outWidth,outHeight,x,y,width,height))});
  }
}
await mkdir('native/fixtures', {recursive:true});
await writeFile('native/fixtures/source-box.json',JSON.stringify(cases));
console.log(`Generated ${cases.length} independent web box fixtures.`);
