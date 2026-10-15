/**
 * Cincin kaca intro dengan glow berbasis cahaya (mode gelap), WebGL2:
 *
 *   H     = softThresholdHighlight(C_in, threshold, softKnee)
 *   B     = sum_{i=1..5} w_i (G_sigma_i * H)
 *   C_out = C_in + 2^exposure * k * B
 *
 * Pipeline: sRGB decode -> luminance -> soft threshold -> Gaussian blur lima
 * skala -> composite aditif -> sRGB encode. Semua di ruang linear.
 *
 * C_in = adegan di sekitar kaca (kanvas IntroBackdrop + isi kaca; di luar area
 * itu warna latar panggung) ditambah garis cincin sebagai cahaya emisif HDR.
 * H hanya dari cincin (latar + isi kaca + garis): stiker dan teks adalah DOM
 * yang hanya sebagian ada di kanvas latar, jadi pendarnya akan terpotong di
 * batas area -- mereka tetap dipakai sebagai C_in saat composite.
 * Skala glow sampai ratusan px, jadi blur dihitung pada piramida mip: H
 * diperkecil bertahap 2x, tiap skala di-blur di level yang membuat sigma-nya
 * beberapa texel, lalu dijumlah kembali ke resolusi px CSS. Kanvas menutupi
 * seluruh panggung, ditumpuk `mix-blend-mode: plus-lighter`, dan hanya
 * mengeluarkan selisih cahaya (C_out - C_in) -- isi halaman di bawahnya tetap.
 * Dihitung ulang hanya bila latar, posisi kaca, atau tema berubah.
 *
 * Mode terang: cahaya aditif tidak terlihat di latar terang, jadi cincin SVG
 * (`.intro-ring`) dipakai; begitu juga bila WebGL2 tidak tersedia.
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { FRAME_ORDER, onFrame } from '../frameLoop';

/** Konfigurasi glow (radius dalam px CSS; sigma = radius / 3). */
const GLOW = {
  threshold: 0.7,
  softKnee: 0.2,
  /** Batas radius skala mana pun. */
  radius: 1000,
  exposure: 0.1,
  exposureGain: Math.pow(2, 0.1),
  /** k (intensitas glow umum). */
  strength: 0.125,
  scales: [
    { radius: 8, weight: 1.0 },
    { radius: 32, weight: 0.7 },
    { radius: 128, weight: 0.45 },
    { radius: 400, weight: 0.25 },
    { radius: 800, weight: 0.12 },
  ],
} as const;

/** Bentuk kaca saat ini (px viewport): elips berpusat (cx, cy), jari-jari rx sepanjang `angle`, ry tegak lurus. */
export interface OrbShape { cx: number; cy: number; rx: number; ry: number; angle: number }
let orbShape: (() => OrbShape | undefined) | undefined;

/**
 * GlassOrb mendaftarkan bentuk kacanya (termasuk geser, regang, dan sudut
 * benda lunaknya) supaya cincin glow menempel persis di tepi kaca -- kotak
 * pembatas DOM tidak bisa menggambarkan elips yang miring.
 */
export function provideOrbShape(source: () => OrbShape | undefined) {
  orbShape = source;
  return () => { if (orbShape === source) orbShape = undefined; };
}

/** Lebar garis cincin (px CSS). */
const LINE_WIDTH = 0.75;
/** Kecerahan garis cincin (linear, HDR: melewati ambang). */
const LINE_INTENSITY = 4;

const VERTEX = `#version 300 es
in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }`;

/** Bagian bersama: adegan (latar + isi kaca), jarak ke tepi kaca, garis cincin. */
const COMMON = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform vec2 uRes;       // ukuran target (px)
uniform vec2 uSize;      // ukuran panggung (px CSS)
uniform vec4 uSceneRect; // area kanvas latar di panggung (x, y, w, h; px CSS)
uniform vec3 uBackground;// warna latar panggung (sRGB)
uniform vec2 uCenter;    // pusat kaca (px CSS)
uniform vec2 uRadius;    // jari-jari kaca (px CSS): sepanjang uAngle, tegak lurus
uniform float uAngle;    // arah regang kaca (radian)
uniform vec4 uFill;      // isi kaca (sRGB, alpha)
uniform float uLineWidth, uLineIntensity;
out vec4 outColor;

vec3 decodeSRGB(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 encodeSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

/** Posisi piksel ini dalam px CSS panggung (y ke bawah). */
vec2 stagePoint() { return vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uRes * uSize; }

/** Jarak bertanda ke tepi elips kaca (px CSS; negatif = di dalam). */
float edgeDistance(vec2 p) {
  vec2 v = p - uCenter;
  float c = cos(uAngle), s = sin(uAngle);
  vec2 q = vec2(c * v.x + s * v.y, -s * v.x + c * v.y) / uRadius;
  float r = max(length(q), 1e-4);
  vec2 grad = q / (r * uRadius);
  return (r - 1.0) / max(length(grad), 1e-4);
}

/** Warna sRGB yang tampil di bawah: latar (kanvas latar di areanya), ditimpa isi kaca. */
vec3 sceneSRGB(vec2 p, float d, float px) {
  vec2 uv = (p - uSceneRect.xy) / uSceneRect.zw;
  vec3 c = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))) ? texture(uScene, uv).rgb : uBackground;
  float inside = clamp(0.5 - d / px, 0.0, 1.0);
  return mix(c, uFill.rgb, uFill.a * inside);
}

/** Sumber cahaya untuk H: latar panggung + isi kaca (tanpa stiker/teks DOM). */
vec3 lightSRGB(float d, float px) {
  float inside = clamp(0.5 - d / px, 0.0, 1.0);
  return mix(uBackground, uFill.rgb, uFill.a * inside);
}

/** Cakupan garis cincin selebar uLineWidth; px = ukuran satu piksel target (px CSS). */
float lineCoverage(float d, float px) {
  float w = uLineWidth / px;
  return clamp(min(w, 0.5 * w + 0.5 - abs(d) / px), 0.0, 1.0);
}
`;

/** H = softThresholdHighlight(C_in, threshold, softKnee), pada px CSS. */
const PREFILTER = `${COMMON}
uniform float uThreshold, uKnee, uEncode;
void main() {
  vec2 p = stagePoint();
  float d = edgeDistance(p);
  vec3 c = decodeSRGB(lightSRGB(d, 1.0)) + lineCoverage(d, 1.0) * uLineIntensity;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contribution = max(soft, l - uThreshold) / max(l, 1e-5);
  outColor = vec4(c * contribution * uEncode, 1.0);
}`;

/** Salin dengan sampel bilinear (turun 2x = rata-rata 2x2; naik = interpolasi), dikali uGain. */
const RESAMPLE = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uRes;
uniform float uGain;
out vec4 outColor;
void main() { outColor = vec4(texture(uSource, gl_FragCoord.xy / uRes).rgb * uGain, 1.0); }`;

/** Satu arah Gaussian (sigma dalam texel level ini). */
const BLUR = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uStep;
uniform float uSigma;
out vec4 outColor;
void main() {
  vec2 size = vec2(textureSize(uSource, 0));
  vec2 base = gl_FragCoord.xy / size;
  vec2 texel = uStep / size;
  int radius = int(ceil(3.0 * uSigma));
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = -64; i <= 64; i++) {
    if (i < -radius || i > radius) continue;
    float x = float(i);
    float weight = exp(-x * x / (2.0 * uSigma * uSigma));
    sum += texture(uSource, base + texel * x).rgb * weight;
    total += weight;
  }
  outColor = vec4(sum / total, 1.0);
}`;

/** C_out = C_in + 2^exposure * k * B, encode sRGB; keluaran = selisih untuk plus-lighter. */
const COMPOSITE = `${COMMON}
uniform sampler2D uBloom;
uniform float uGain, uDecode, uPx;
void main() {
  vec2 p = stagePoint();
  float d = edgeDistance(p);
  vec3 base = sceneSRGB(p, d, uPx);
  // Target render (FBO) baris 0 = bawah panggung.
  vec3 bloom = texture(uBloom, vec2(p.x, uSize.y - p.y) / uSize).rgb * uDecode;
  vec3 c = decodeSRGB(base) + lineCoverage(d, uPx) * uLineIntensity + uGain * bloom;
  vec3 delta = max(encodeSRGB(clamp(c, 0.0, 1.0)) - base, 0.0);
  outColor = vec4(delta, max(delta.r, max(delta.g, delta.b)));
}`;

type Target = { texture: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };

export function RingBloom({ backdrop }: { backdrop: RefObject<HTMLCanvasElement | null> }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const stage = canvas?.parentElement;
    const gl = canvas?.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!canvas || !stage || !gl) return undefined;
    // Target H dan blur: half float bila bisa (HDR), selain itu RGBA8 berskala 1/8.
    const float = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    const ENCODE = float ? 1 : 1 / 8;

    const compile = (fragment: string) => {
      const make = (type: number, source: string) => {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
      };
      const program = gl.createProgram()!;
      gl.attachShader(program, make(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, make(gl.FRAGMENT_SHADER, fragment));
      gl.bindAttribLocation(program, 0, 'aPosition');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
      const uniforms = new Map<string, WebGLUniformLocation | null>();
      return { program, u: (name: string) => { if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name)); return uniforms.get(name)!; } };
    };
    const prefilter = compile(PREFILTER), resample = compile(RESAMPLE), blur = compile(BLUR), composite = compile(COMPOSITE);
    if (!prefilter || !resample || !blur || !composite) return undefined;
    type Program = NonNullable<typeof prefilter>;

    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const texture = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    };
    const target = (): Target => ({ texture: texture(), fbo: gl.createFramebuffer()!, w: 0, h: 0 });
    const resize = (t: Target, w: number, h: number) => {
      if (t.w === w && t.h === h) return;
      t.w = w; t.h = h;
      gl.bindTexture(gl.TEXTURE_2D, t.texture);
      if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.texture, 0);
    };
    const scene = texture();
    // Piramida: per level H (diperkecil), hasil blur horizontal, hasil blur penuh.
    const levels: { h: Target; temp: Target; out: Target }[] = [];
    const sum = target();
    const all = () => [sum, ...levels.flatMap((l) => [l.h, l.temp, l.out])];

    const pass = (p: Program, into: Target | null, w: number, h: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.fbo : null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(p.program);
      gl.uniform2f(p.u('uRes'), w, h);
    };
    const bind = (unit: number, t: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
    };

    let frame = 0, drawn = '', dark = false;
    let fill: [number, number, number, number] = [1, 1, 1, 0.1], background: [number, number, number] = [0, 0, 0];
    const rgba = (value: string) => value.match(/[\d.]+/g)?.map(Number) ?? [];
    const draw = () => {
      const source = backdrop.current;
      const glass = stage.querySelector('.intro-glass');
      if (frame++ % 30 === 0) {
        const sky = stage.querySelector<HTMLElement>('.intro-sky');
        dark = !!sky && (getComputedStyle(sky).getPropertyValue('--intro-star').trim() || '255').startsWith('255');
        const tint = stage.querySelector('.intro-fill');
        const f = tint ? rgba(getComputedStyle(tint).fill) : [];
        if (f.length >= 3) fill = [f[0]! / 255, f[1]! / 255, f[2]! / 255, f[3] ?? 1];
        const b = rgba(getComputedStyle(stage).backgroundColor);
        if (b.length >= 3) background = [b[0]! / 255, b[1]! / 255, b[2]! / 255];
      }
      const active = dark && !!source && !!glass && !!source.dataset.frame && source.width > 0;
      if (active) stage.dataset.bloom = ''; else delete stage.dataset.bloom;
      canvas.style.display = active ? '' : 'none';
      if (!active || !source || !glass) return;

      const W = stage.clientWidth, H = stage.clientHeight;
      const sx = source.offsetLeft, sy = source.offsetTop, sw = source.offsetWidth, sh = source.offsetHeight;
      if (!W || !H || !sw || !sh) return;
      const origin = stage.getBoundingClientRect(), box = glass.getBoundingClientRect();
      const shape = orbShape?.() ?? { cx: box.left + box.width / 2, cy: box.top + box.height / 2, rx: box.width / 2, ry: box.height / 2, angle: 0 };
      const cx = shape.cx - origin.left, cy = shape.cy - origin.top;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const signature = [W, H, sx, sy, sw, sh, cx, cy, shape.rx, shape.ry, shape.angle, ratio, source.dataset.frame, fill.join(','), background.join(',')].join('|');
      if (signature === drawn) return;
      drawn = signature;

      const cw = Math.round(W * ratio), ch = Math.round(H * ratio);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      bind(0, scene);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

      // Piramida px CSS: level 0 = panggung, tiap level setengahnya.
      const bw = Math.max(1, Math.round(W)), bh = Math.max(1, Math.round(H));
      const depth = Math.max(1, Math.floor(Math.log2(Math.min(bw, bh))) - 1);
      while (levels.length < depth) levels.push({ h: target(), temp: target(), out: target() });
      levels.forEach((l, i) => {
        const lw = Math.max(1, Math.round(bw / 2 ** i)), lh = Math.max(1, Math.round(bh / 2 ** i));
        resize(l.h, lw, lh); resize(l.temp, lw, lh); resize(l.out, lw, lh);
      });
      resize(sum, bw, bh);
      const scenery = (p: Program) => {
        gl.uniform1i(p.u('uScene'), 0);
        gl.uniform2f(p.u('uSize'), W, H);
        gl.uniform4f(p.u('uSceneRect'), sx, sy, sw, sh);
        gl.uniform3f(p.u('uBackground'), ...background);
        gl.uniform2f(p.u('uCenter'), cx, cy);
        gl.uniform2f(p.u('uRadius'), shape.rx, shape.ry);
        gl.uniform1f(p.u('uAngle'), shape.angle);
        gl.uniform4f(p.u('uFill'), ...fill);
        gl.uniform1f(p.u('uLineWidth'), LINE_WIDTH);
        gl.uniform1f(p.u('uLineIntensity'), LINE_INTENSITY);
      };
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);

      // 1. H (level 0), lalu turunkan ke tiap level.
      const top = levels[0]!;
      pass(prefilter, top.h, top.h.w, top.h.h);
      scenery(prefilter);
      bind(0, scene);
      gl.uniform1f(prefilter.u('uThreshold'), GLOW.threshold);
      gl.uniform1f(prefilter.u('uKnee'), GLOW.softKnee);
      gl.uniform1f(prefilter.u('uEncode'), ENCODE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      for (let i = 1; i < levels.length; i++) {
        const l = levels[i]!;
        pass(resample, l.h, l.h.w, l.h.h);
        gl.uniform1i(resample.u('uSource'), 0);
        gl.uniform1f(resample.u('uGain'), 1);
        bind(0, levels[i - 1]!.h.texture);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      // 2. B = sum_i w_i (G_sigma_i * H): tiap skala di level dengan sigma 3-6 texel, naik ke sum.
      gl.bindFramebuffer(gl.FRAMEBUFFER, sum.fbo);
      gl.viewport(0, 0, sum.w, sum.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      GLOW.scales.forEach(({ radius, weight }) => {
        const sigma = Math.min(radius, GLOW.radius) / 3;
        const index = Math.max(0, Math.min(levels.length - 1, Math.floor(Math.log2(Math.max(1, sigma / 3)))));
        const l = levels[index]!;
        const texels = sigma / 2 ** index;
        gl.disable(gl.BLEND);
        pass(blur, l.temp, l.temp.w, l.temp.h);
        gl.uniform1i(blur.u('uSource'), 0);
        gl.uniform1f(blur.u('uSigma'), texels);
        gl.uniform2f(blur.u('uStep'), 1, 0);
        bind(0, l.h.texture);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        pass(blur, l.out, l.out.w, l.out.h);
        gl.uniform2f(blur.u('uStep'), 0, 1);
        bind(0, l.temp.texture);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        pass(resample, sum, sum.w, sum.h);
        gl.uniform1i(resample.u('uSource'), 0);
        gl.uniform1f(resample.u('uGain'), weight);
        bind(0, l.out.texture);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      });
      gl.disable(gl.BLEND);

      // 3. C_out = C_in + 2^exposure * k * B, resolusi layar.
      pass(composite, null, cw, ch);
      scenery(composite);
      bind(0, scene);
      bind(1, sum.texture);
      gl.uniform1i(composite.u('uBloom'), 1);
      gl.uniform1f(composite.u('uGain'), GLOW.exposureGain * GLOW.strength);
      gl.uniform1f(composite.u('uDecode'), 1 / ENCODE);
      gl.uniform1f(composite.u('uPx'), 1 / ratio);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
    };
    const off = onFrame(draw, FRAME_ORDER.bloom);
    return () => {
      off();
      delete stage.dataset.bloom;
      all().forEach((t) => { gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.fbo); });
      gl.deleteTexture(scene);
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      [prefilter, resample, blur, composite].forEach((p) => gl.deleteProgram(p.program));
    };
  }, [backdrop]);

  return <canvas ref={ref} className="intro-bloom" aria-hidden="true" />;
}
