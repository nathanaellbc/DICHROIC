struct Controls { count: u32, exposureEv: f32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<uniform> controls: Controls;

fn decode(v: f32) -> f32 {
  if (v <= 0.04045) { return v / 12.92; }
  return pow((v + 0.055) / 1.055, 2.4);
}
fn encode(v: f32) -> u32 {
  let c = clamp(v, 0.0, 1.0);
  var s = 12.92 * c;
  if (c > 0.0031308) { s = 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
  return u32(floor(clamp(s, 0.0, 1.0) * 255.0 + 0.5));
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= controls.count) { return; }
  let pixel = source[id.x];
  let gain = exp2(controls.exposureEv);
  let r = encode(decode(f32(pixel & 255u) / 255.0) * gain);
  let g = encode(decode(f32((pixel >> 8u) & 255u) / 255.0) * gain);
  let b = encode(decode(f32((pixel >> 16u) & 255u) / 255.0) * gain);
  destination[id.x] = r | (g << 8u) | (b << 16u) | (pixel & 0xff000000u);
}
