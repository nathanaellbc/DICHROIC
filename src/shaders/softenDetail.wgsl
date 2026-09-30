struct Settings { size: vec4<u32>, control: vec4<f32>, luma: vec4<f32> }
@group(0) @binding(0) var<storage, read> source: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dest: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> a: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> b: array<vec2<f32>>;
@group(0) @binding(4) var<uniform> cfg: Settings;
fn index(p: vec2<i32>) -> u32 { let q = clamp(p, vec2<i32>(0), vec2<i32>(cfg.size.xy) - vec2<i32>(1)); return u32(q.y) * cfg.size.x + u32(q.x); }
fn weight(k: i32) -> f32 { let t = f32(k) / cfg.control.y; return exp(-0.5 * t * t); }
fn intensity(rgb: vec3<f32>) -> f32 { return log(1.0 + max(0.0, dot(cfg.luma.xyz, rgb))); }
@compute @workgroup_size(16, 8) fn momentsX(@builtin(global_invocation_id) gid: vec3<u32>) {
 if (any(gid.xy >= cfg.size.xy)) { return; }
 var sum = vec2<f32>(0.0); var total = 0.0;
 for(var k = -i32(cfg.size.z); k <= i32(cfg.size.z); k++) { let w = weight(k); let v = intensity(source[index(vec2<i32>(gid.xy) + vec2<i32>(k, 0))].rgb); sum += w * vec2<f32>(v, v*v); total += w; }
 a[index(vec2<i32>(gid.xy))] = sum / total;
}
@compute @workgroup_size(16, 8) fn coefficientsY(@builtin(global_invocation_id) gid: vec3<u32>) {
 if (any(gid.xy >= cfg.size.xy)) { return; }
 var sum = vec2<f32>(0.0); var total = 0.0;
 for(var k = -i32(cfg.size.z); k <= i32(cfg.size.z); k++) { let w = weight(k); sum += w * a[index(vec2<i32>(gid.xy) + vec2<i32>(0, k))]; total += w; }
 let m = sum / total; let variance = max(0.0, m.y-m.x*m.x); let slope = variance / (variance + 0.0025);
 b[index(vec2<i32>(gid.xy))] = vec2<f32>(slope, m.x*(1.0-slope));
}
@compute @workgroup_size(16, 8) fn coefficientsX(@builtin(global_invocation_id) gid: vec3<u32>) {
 if (any(gid.xy >= cfg.size.xy)) { return; }
 var sum = vec2<f32>(0.0); var total = 0.0;
 for(var k = -i32(cfg.size.z); k <= i32(cfg.size.z); k++) { let w = weight(k); sum += w * b[index(vec2<i32>(gid.xy) + vec2<i32>(k, 0))]; total += w; }
 a[index(vec2<i32>(gid.xy))] = sum / total;
}
@compute @workgroup_size(16, 8) fn combineY(@builtin(global_invocation_id) gid: vec3<u32>) {
 if (any(gid.xy >= cfg.size.xy)) { return; }
 var sum = vec2<f32>(0.0); var total = 0.0;
 for(var k = -i32(cfg.size.z); k <= i32(cfg.size.z); k++) { let w = weight(k); sum += w * a[index(vec2<i32>(gid.xy) + vec2<i32>(0, k))]; total += w; }
 let coefficients = sum / total; let i = index(vec2<i32>(gid.xy)); let rgb = source[i].rgb; let v = intensity(rgb); let before = exp(v)-1.0;
 let after = exp(coefficients.x*v+coefficients.y)-1.0;
 var gain = 1.0; if(before > 1e-6) { gain = clamp(after/before, 0.8, 1.25); }
 dest[i] = vec4<f32>(rgb * mix(1.0, gain, cfg.control.x*0.9), source[i].a);
}
