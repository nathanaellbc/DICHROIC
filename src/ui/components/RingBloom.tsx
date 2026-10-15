/**
 * Cincin kaca intro dengan bloom berbasis cahaya (mode gelap), satu pass WebGL2:
 *
 *   C_out = EncodeSRGB(T(C_linear + k * sum_i(w_i * GaussianBlur(H_RGB, sigma_i))))
 *   H_RGB = softThresholdHighlight(C_linear, threshold, softKnee)
 *
 * Pipeline: sRGB decode -> luminance -> soft threshold -> Gaussian blur
 * multi-skala -> composite aditif -> tone map -> sRGB encode.
 *
 * C_linear = adegan di sekitar kaca (kanvas IntroBackdrop + isi kaca) ditambah
 * garis cincin sebagai cahaya emisif HDR -- hanya garis itu yang melewati
 * ambang, jadi hanya cincin yang berpendar. Kanvas ini ditumpuk dengan
 * `mix-blend-mode: plus-lighter` dan hanya mengeluarkan selisih cahaya
 * (C_out - C), jadi isi halaman di bawahnya tetap. Blur dihitung pada resolusi
 * px CSS, composite pada resolusi layar; semuanya hanya dihitung ulang bila
 * latar, posisi kaca, atau tema berubah.
 *
 * Mode terang: cahaya aditif tidak terlihat di latar terang, jadi cincin SVG
 * (`.intro-ring`) dipakai; begitu juga bila WebGL2 tidak tersedia.
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Lebar garis cincin (px CSS). */
const LINE_WIDTH = 0.75;
/** Kecerahan garis cincin (linear, HDR: > 1 supaya melewati ambang). */
const LINE_INTENSITY = 4;
const THRESHOLD = 1;
const SOFT_KNEE = 0.1;
/** k: kekuatan bloom. */
const STRENGTH = 1;
/** sigma_i (px CSS) dan w_i. */
const SIGMAS = [1.5, 5, 14] as const;
const WEIGHTS = [0.45, 0.35, 0.2] as const;
/** Awal bahu tone map (linear); di bawahnya T = identitas. */
const SHOULDER = 0.8;

const VERTEX = `#version 300 es
in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }`;

/** Bagian bersama: adegan (latar + isi kaca), jarak ke tepi kaca, garis cincin. */
const COMMON = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform vec2 uRes;      // ukuran target (px)
uniform vec2 uSize;     // ukuran area (px CSS)
uniform vec2 uCenter;   // pusat kaca (px CSS, area)
uniform vec2 uRadius;   // jari-jari kaca (px CSS)
uniform vec4 uFill;     // isi kaca (sRGB, alpha)
uniform float uLineWidth, uLineIntensity;
out vec4 outColor;

vec3 decodeSRGB(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 encodeSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

/** Posisi piksel ini dalam px CSS area (y ke bawah). */
vec2 areaPoint() { return vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uRes * uSize; }

/** Jarak bertanda ke tepi elips kaca (px CSS; negatif = di dalam). */
float edgeDistance(vec2 p) {
  vec2 q = (p - uCenter) / uRadius;
  float r = max(length(q), 1e-4);
  vec2 grad = q / (r * uRadius);
  return (r - 1.0) / max(length(grad), 1e-4);
}

/** Warna sRGB yang tampil di bawah: latar, ditimpa isi kaca di dalam elips. */
vec3 sceneSRGB(vec2 p, float d, float px) {
  vec3 c = texture(uScene, clamp(p / uSize, 0.0, 1.0)).rgb;
  float inside = clamp(0.5 - d / px, 0.0, 1.0);
  return mix(c, uFill.rgb, uFill.a * inside);
}

/** Cakupan garis cincin selebar uLineWidth; px = ukuran satu piksel target (px CSS). */
float lineCoverage(float d, float px) {
  float w = uLineWidth / px;
  return clamp(min(w, 0.5 * w + 0.5 - abs(d) / px), 0.0, 1.0);
}
`;

/** H_RGB = softThresholdHighlight(C_linear, threshold, softKnee), pada px CSS. */
const PREFILTER = `${COMMON}
uniform float uThreshold, uKnee, uEncode;
void main() {
  vec2 p = areaPoint();
  float d = edgeDistance(p);
  vec3 c = decodeSRGB(sceneSRGB(p, d, 1.0)) + lineCoverage(d, 1.0) * uLineIntensity;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contribution = max(soft, l - uThreshold) / max(l, 1e-5);
  outColor = vec4(c * contribution * uEncode, 1.0);
}`;

/** Satu arah Gaussian (sigma dalam texel); hasilnya dikali uGain (w_i) dan dijumlah lewat blending. */
const BLUR = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uStep;
uniform float uSigma, uGain;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uSource, 0);
  vec2 base = gl_FragCoord.xy / vec2(size);
  vec2 texel = uStep / vec2(size);
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
  outColor = vec4(sum / total * uGain, 1.0);
}`;

/** Composite aditif, tone map, encode; keluaran = selisih cahaya untuk plus-lighter. */
const COMPOSITE = `${COMMON}
uniform sampler2D uBloom;
uniform float uStrength, uDecode, uShoulder, uPx;
vec3 toneMap(vec3 x) {
  vec3 over = max(x - uShoulder, 0.0);
  vec3 room = vec3(1.0 - uShoulder);
  return mix(x, uShoulder + room * (1.0 - exp(-over / room)), step(uShoulder, x));
}
void main() {
  vec2 p = areaPoint();
  float d = edgeDistance(p);
  vec3 base = sceneSRGB(p, d, uPx);
  // Target render (FBO) baris 0 = bawah area.
  vec3 bloom = texture(uBloom, clamp(vec2(p.x, uSize.y - p.y) / uSize, 0.0, 1.0)).rgb * uDecode;
  vec3 c = decodeSRGB(base) + lineCoverage(d, uPx) * uLineIntensity + uStrength * bloom;
  vec3 delta = max(encodeSRGB(clamp(toneMap(c), 0.0, 1.0)) - base, 0.0);
  outColor = vec4(delta, max(delta.r, max(delta.g, delta.b)));
}`;

export function RingBloom({ backdrop }: { backdrop: RefObject<HTMLCanvasElement | null> }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const stage = canvas?.parentElement;
    const gl = canvas?.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!canvas || !stage || !gl) return undefined;
    // Target H dan bloom: half float bila bisa (HDR), selain itu RGBA8 berskala 1/8.
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
    const prefilter = compile(PREFILTER), blur = compile(BLUR), composite = compile(COMPOSITE);
    if (!prefilter || !blur || !composite) return undefined;

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
    const scene = texture();
    // Tiga target px CSS: H, hasil blur horizontal, jumlah bloom.
    const targets = [0, 1, 2].map(() => ({ texture: texture(), fbo: gl.createFramebuffer()!, w: 0, h: 0 }));
    const resize = (target: (typeof targets)[number], w: number, h: number) => {
      if (target.w === w && target.h === h) return;
      target.w = w; target.h = h;
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
    };

    let raf = 0, frame = 0, drawn = '', dark = false, fill: [number, number, number, number] = [1, 1, 1, 0.1];
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const source = backdrop.current;
      const glass = stage.querySelector('.intro-glass');
      if (frame++ % 30 === 0) {
        const sky = stage.querySelector<HTMLElement>('.intro-sky');
        dark = !!sky && (getComputedStyle(sky).getPropertyValue('--intro-star').trim() || '255').startsWith('255');
        const tint = stage.querySelector('.intro-fill');
        const m = tint && getComputedStyle(tint).fill.match(/[\d.]+/g);
        if (m && m.length >= 3) fill = [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255, m[3] !== undefined ? Number(m[3]) : 1];
      }
      const active = dark && !!source && !!glass && !!source.dataset.frame && source.width > 0;
      if (active) stage.dataset.bloom = ''; else delete stage.dataset.bloom;
      canvas.style.display = active ? '' : 'none';
      if (!active || !source || !glass) return;

      // Area = area kanvas latar (IntroBackdrop menempatkannya di sekitar kaca).
      const x0 = source.offsetLeft, y0 = source.offsetTop, w = source.offsetWidth, h = source.offsetHeight;
      if (!w || !h) return;
      const origin = stage.getBoundingClientRect(), box = glass.getBoundingClientRect();
      const cx = box.left - origin.left - x0 + box.width / 2, cy = box.top - origin.top - y0 + box.height / 2;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const signature = [x0, y0, w, h, cx, cy, box.width, box.height, ratio, source.dataset.frame, fill.join(',')].join('|');
      if (signature === drawn) return;
      drawn = signature;

      Object.assign(canvas.style, { left: `${x0}px`, top: `${y0}px`, width: `${w}px`, height: `${h}px` });
      const cw = Math.round(w * ratio), ch = Math.round(h * ratio);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      gl.bindTexture(gl.TEXTURE_2D, scene);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

      const bw = Math.max(1, Math.round(w)), bh = Math.max(1, Math.round(h));
      targets.forEach((t) => resize(t, bw, bh));
      const [hTarget, temp, sum] = targets as [typeof targets[0], typeof targets[0], typeof targets[0]];
      const shared = (p: NonNullable<typeof prefilter>, rw: number, rh: number) => {
        gl.useProgram(p.program);
        gl.uniform1i(p.u('uScene'), 0);
        gl.uniform2f(p.u('uRes'), rw, rh);
        gl.uniform2f(p.u('uSize'), w, h);
        gl.uniform2f(p.u('uCenter'), cx, cy);
        gl.uniform2f(p.u('uRadius'), box.width / 2, box.height / 2);
        gl.uniform4f(p.u('uFill'), ...fill);
        gl.uniform1f(p.u('uLineWidth'), LINE_WIDTH);
        gl.uniform1f(p.u('uLineIntensity'), LINE_INTENSITY);
      };
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);

      // 1. H_RGB (px CSS).
      gl.bindFramebuffer(gl.FRAMEBUFFER, hTarget.fbo);
      gl.viewport(0, 0, bw, bh);
      shared(prefilter, bw, bh);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, scene);
      gl.uniform1f(prefilter.u('uThreshold'), THRESHOLD);
      gl.uniform1f(prefilter.u('uKnee'), SOFT_KNEE);
      gl.uniform1f(prefilter.u('uEncode'), ENCODE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2. sum_i w_i * GaussianBlur(H, sigma_i): horizontal ke temp, vertikal dijumlah ke sum.
      gl.bindFramebuffer(gl.FRAMEBUFFER, sum.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(blur.program);
      gl.uniform1i(blur.u('uSource'), 0);
      SIGMAS.forEach((sigma, i) => {
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, temp.fbo);
        gl.bindTexture(gl.TEXTURE_2D, hTarget.texture);
        gl.uniform2f(blur.u('uStep'), 1, 0);
        gl.uniform1f(blur.u('uSigma'), sigma);
        gl.uniform1f(blur.u('uGain'), 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, sum.fbo);
        gl.bindTexture(gl.TEXTURE_2D, temp.texture);
        gl.uniform2f(blur.u('uStep'), 0, 1);
        gl.uniform1f(blur.u('uGain'), WEIGHTS[i]!);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      });
      gl.disable(gl.BLEND);

      // 3. EncodeSRGB(T(C + k * bloom)) - C, resolusi layar.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      shared(composite, cw, ch);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, scene);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sum.texture);
      gl.uniform1i(composite.u('uBloom'), 1);
      gl.uniform1f(composite.u('uStrength'), STRENGTH);
      gl.uniform1f(composite.u('uDecode'), 1 / ENCODE);
      gl.uniform1f(composite.u('uShoulder'), SHOULDER);
      gl.uniform1f(composite.u('uPx'), 1 / ratio);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      delete stage.dataset.bloom;
      targets.forEach((t) => { gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.fbo); });
      gl.deleteTexture(scene);
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      [prefilter, blur, composite].forEach((p) => gl.deleteProgram(p.program));
    };
  }, [backdrop]);

  return <canvas ref={ref} className="intro-bloom" aria-hidden="true" />;
}
