/**
 * Wordmark "DICHROIC" sebagai kaca dikroik yang menggembung: huruf bulat
 * (Fredoka) dijadikan peta tinggi (alfa diburamkan = lengkung balon), lalu
 * shader WebGL menghitung normal dari peta itu dan mewarnainya dengan:
 *  - pantulan krom dari lingkungan studio prosedural (langit terang, horizon,
 *    lantai gelap, satu garis cahaya),
 *  - interferensi lapisan tipis (thin-film) -- warna kaca dikroik yang
 *    bergeser dengan sudut pandang, ketebalan, waktu, dan posisi kursor,
 *  - Fresnel: tepi lebih memantul, permukaan datar lebih berwarna.
 * Kursor/jari memiringkan cahaya. Reduce Motion: satu frame diam. Tanpa
 * WebGL: krom SVG lama.
 */
import { useEffect, useRef, useState } from 'react';
import '@fontsource-variable/fredoka';

const W = 1280, H = 360;

const VERT = `attribute vec2 p; varying vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `precision highp float;
varying vec2 uv;
uniform sampler2D height;   // r: lengkung balon (blur besar), g: alfa huruf tajam
uniform vec2 texel;
uniform float time;
uniform vec2 tilt;          // -1..1, dari kursor/jari

vec3 env(vec3 r) {
  // Studio: langit putih kebiruan di atas, horizon terang, lantai gelap.
  float y = r.y;
  vec3 sky = mix(vec3(0.62, 0.72, 0.86), vec3(0.98, 0.99, 1.0), smoothstep(0.0, 0.9, y));
  vec3 floorc = mix(vec3(0.02, 0.03, 0.05), vec3(0.16, 0.18, 0.22), smoothstep(-1.0, -0.05, y));
  vec3 c = y > 0.0 ? sky : floorc;
  c += vec3(1.0) * smoothstep(0.06, 0.0, abs(y - 0.02)) * 0.9;              // garis horizon
  c += vec3(0.7, 0.85, 1.0) * smoothstep(0.985, 1.0, dot(r, normalize(vec3(-0.5 + tilt.x * 0.6, 0.6 - tilt.y * 0.4, 0.55)))) * 2.5; // softbox
  return c;
}

vec3 thinFilm(float d) {
  // Interferensi lapisan tipis (ketebalan optik d, nm) -> warna, kira-kira RGB 650/530/450 nm.
  vec3 lambda = vec3(650.0, 532.0, 450.0);
  return 0.5 + 0.5 * cos(6.2831853 * (2.0 * d / lambda));
}

void main() {
  vec2 t = texture2D(height, uv).rg;
  float a = t.g;
  if (a < 0.003) discard;
  float h = t.r;
  // Gradien di dua jarak dirata-rata: normal halus tanpa butiran 8-bit.
  vec2 o1 = texel, o2 = texel * 2.5;
  float hx = (texture2D(height, uv + vec2(o1.x, 0.0)).r - texture2D(height, uv - vec2(o1.x, 0.0)).r) / 2.0
           + (texture2D(height, uv + vec2(o2.x, 0.0)).r - texture2D(height, uv - vec2(o2.x, 0.0)).r) / 5.0;
  float hy = (texture2D(height, uv + vec2(0.0, o1.y)).r - texture2D(height, uv - vec2(0.0, o1.y)).r) / 2.0
           + (texture2D(height, uv + vec2(0.0, o2.y)).r - texture2D(height, uv - vec2(0.0, o2.y)).r) / 5.0;
  vec3 n = normalize(vec3(-hx * 7.0, -hy * 7.0, 1.0));
  vec3 v = vec3(0.0, 0.0, 1.0);
  vec3 r = reflect(-v, n);
  r.xy += tilt * vec2(0.35, -0.25);
  r = normalize(r);
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 3.0);
  vec3 chrome = env(r);
  // Ketebalan film: lebih tebal di puncak balon, bergelombang pelan, digeser kursor.
  float d = 320.0 + h * 260.0 + (1.0 - ndv) * 420.0 + sin(uv.x * 7.0 + time * 0.6) * 40.0 + tilt.x * 90.0;
  vec3 film = thinFilm(d);
  // Perak dulu; warna dikroik muncul di sudut miring (Fresnel), seperti kaca aslinya.
  float tint = 0.12 + 0.55 * smoothstep(0.15, 0.9, 1.0 - ndv);
  vec3 col = chrome * mix(vec3(1.0), film * 1.15, tint);
  // Kilap specular tajam dan sedikit bayangan dalam di lipatan.
  col += pow(max(dot(r, normalize(vec3(0.3 + tilt.x * 0.5, 0.7, 0.6))), 0.0), 60.0) * 0.9;
  col *= mix(0.55, 1.0, smoothstep(0.0, 0.35, h));
  gl_FragColor = vec4(col * a, a);
}`;

/** Peta tinggi: alfa huruf diburamkan berlapis (lengkung balon) di R, alfa tajam di G. */
function heightTexture(text: string, family: string): HTMLCanvasElement {
  const sharp = document.createElement('canvas');
  sharp.width = W; sharp.height = H;
  const s = sharp.getContext('2d')!;
  s.fillStyle = '#fff';
  s.textAlign = 'center'; s.textBaseline = 'middle';
  // Huruf sebesar mungkin yang muat.
  let size = 260;
  s.font = `700 ${size}px ${family}`;
  while (s.measureText(text).width > W * 0.92 && size > 40) { size -= 6; s.font = `700 ${size}px ${family}`; }
  s.fillText(text, W / 2, H / 2 + size * 0.04);

  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const o = out.getContext('2d')!;
  // Lengkung: tiga blur ditumpuk lalu dipotong oleh bentuk huruf.
  const soft = document.createElement('canvas');
  soft.width = W; soft.height = H;
  const f = soft.getContext('2d')!;
  for (const [blur, alpha] of [[size * 0.09, 0.55], [size * 0.045, 0.3], [size * 0.02, 0.15]] as const) {
    f.globalAlpha = alpha;
    f.filter = `blur(${blur}px)`;
    f.drawImage(sharp, 0, 0);
  }
  f.globalAlpha = 1; f.filter = 'none';
  f.globalCompositeOperation = 'destination-in';
  f.drawImage(sharp, 0, 0);
  // R = lengkung, G = alfa tajam.
  const hd = f.getImageData(0, 0, W, H).data, sd = s.getImageData(0, 0, W, H).data;
  const img = o.createImageData(W, H);
  for (let i = 0; i < hd.length; i += 4) {
    // Profil balon: akar dari alfa buram (bahu bulat, puncak landai).
    img.data[i] = Math.round(255 * Math.sqrt(Math.min(1, (hd[i + 3]! / 255) * 1.5)));
    img.data[i + 1] = sd[i + 3]!;
    img.data[i + 3] = 255;
  }
  o.putImageData(img, 0, 0);
  return out;
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
  return sh;
}

export function DichroicWordmark({ text = 'DICHROIC', reduce, fallback }: { text?: string; reduce: boolean; fallback: React.ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return undefined;
    let raf = 0, alive = true;
    const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
    const family = '"Fredoka Variable", "Fredoka", ui-rounded, system-ui, sans-serif';
    const move = (e: PointerEvent) => {
      tilt.tx = (e.clientX / window.innerWidth) * 2 - 1;
      tilt.ty = (e.clientY / window.innerHeight) * 2 - 1;
    };
    const orient = (e: DeviceOrientationEvent) => {
      if (e.gamma == null || e.beta == null) return;
      tilt.tx = Math.max(-1, Math.min(1, e.gamma / 30));
      tilt.ty = Math.max(-1, Math.min(1, (e.beta - 45) / 30));
    };
    let cleanup = () => {};
    (async () => {
      try {
        await document.fonts.load(`700 100px "Fredoka Variable"`);
        if (!alive) return;
        const gl = el.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: true });
        if (!gl) throw new Error('no webgl');
        const prog = gl.createProgram()!;
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'p');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, heightTexture(text, family));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform2f(gl.getUniformLocation(prog, 'texel'), 2 / W, 2 / H);
        const uTime = gl.getUniformLocation(prog, 'time'), uTilt = gl.getUniformLocation(prog, 'tilt');
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const resize = () => {
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          el.width = Math.round(el.clientWidth * dpr);
          el.height = Math.round(el.clientHeight * dpr);
          gl.viewport(0, 0, el.width, el.height);
        };
        resize();
        const start = performance.now();
        const draw = (now: number) => {
          // Kemiringan mengejar target dengan redaman (tanpa lompatan).
          tilt.x += (tilt.tx - tilt.x) * 0.08;
          tilt.y += (tilt.ty - tilt.y) * 0.08;
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.uniform1f(uTime, reduce ? 0 : (now - start) / 1000);
          gl.uniform2f(uTilt, tilt.x, tilt.y);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          if (!reduce && alive) raf = requestAnimationFrame(draw);
        };
        raf = requestAnimationFrame(draw);
        window.addEventListener('resize', resize);
        if (!reduce) {
          window.addEventListener('pointermove', move);
          window.addEventListener('deviceorientation', orient);
        }
        cleanup = () => {
          window.removeEventListener('resize', resize);
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        };
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('deviceorientation', orient);
      cleanup();
    };
  }, [text, reduce]);

  if (failed) return <>{fallback}</>;
  return <canvas ref={canvas} className="dichroic-wordmark" role="img" aria-label={text} style={{ aspectRatio: `${W} / ${H}` }} />;
}
