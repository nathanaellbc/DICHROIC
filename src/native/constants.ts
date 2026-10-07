// WebGPU specification bitmasks, also used by wgpu's C descriptor boundary.
// The headless JavaScriptCore bundle has no browser or Dawn globals.
export const gpuBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4,
  COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
  INDIRECT: 256, QUERY_RESOLVE: 512 } as typeof GPUBufferUsage;
export const gpuMapMode = { READ: 1, WRITE: 2 } as typeof GPUMapMode;
export const gpuTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 } as typeof GPUTextureUsage;
