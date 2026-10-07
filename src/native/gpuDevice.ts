/** Native boundary: only descriptors are JSON. Pixel/table bytes are binary. */
export interface NativeGpuHost {
  command(json: string): string;
  upload(id: number, offset: number, bytes: Uint8Array): void;
  read(id: number, offset: number, size: number): ArrayBuffer | Promise<ArrayBuffer>;
}

type Command = Record<string, unknown>;
type Layout = { pipeline: number; index: number };
type NativeResource = { id: number };

/** The canonical host/stage code targets this adapter; compute runs in Rust/wgpu. */
export class NativeGpuDevice {
  readonly limits: GPUSupportedLimits;
  readonly queue: {
    writeBuffer: (buffer: NativeBuffer, offset: number, source: ArrayBuffer | ArrayBufferView, dataOffset?: number, size?: number) => void;
    submit: (commands: Array<{ commands: Command[] }>) => void;
    onSubmittedWorkDone: () => Promise<void>;
  };
  private readonly pipelines = new Map<string, { id: number; label: string; getBindGroupLayout(index: number): Layout }>();
  private readonly temporary = new Set<number>();
  private sampler?: NativeResource;
  private readonly scopes: Array<{ filter: GPUErrorFilter; error?: Error }> = [];

  constructor(readonly host: NativeGpuHost) {
    this.limits = this.call({ op: 'limits' }) as GPUSupportedLimits;
    this.queue = {
      writeBuffer: (buffer, offset, source, dataOffset = 0, size) => {
        const view = ArrayBuffer.isView(source);
        const stride = view && 'BYTES_PER_ELEMENT' in source ? Number(source.BYTES_PER_ELEMENT) : 1;
        const bytes = new Uint8Array(view ? source.buffer : source,
          (view ? source.byteOffset : 0) + dataOffset * stride,
          size === undefined ? source.byteLength - dataOffset * stride : size * stride);
        buffer.assertAlive();
        this.host.upload(buffer.id, offset, bytes);
      },
      submit: (buffers) => {
        try { this.call({ op: 'submit', commands: buffers.flatMap(buffer => buffer.commands) }); }
        finally {
          for (const id of this.temporary) this.call({ op: 'destroy', id });
          this.temporary.clear();
        }
      },
      onSubmittedWorkDone: () => Promise.resolve(),
    };
  }

  call(command: Command): unknown {
    const result = JSON.parse(this.host.command(JSON.stringify(command))) as { result?: unknown; error?: string };
    if (result.error !== undefined) {
      const error = new Error(result.error);
      const type = /memory budget|out of memory/i.test(result.error) ? 'out-of-memory' : 'validation';
      const scope = [...this.scopes].reverse().find(scope => scope.filter === type);
      if (scope) scope.error ??= error;
      throw error;
    }
    return result.result;
  }

  createBuffer(descriptor: GPUBufferDescriptor): NativeBuffer {
    return new NativeBuffer(this, Number(this.call({ op: 'buffer', size: descriptor.size, usage: descriptor.usage, label: descriptor.label })), descriptor);
  }
  createShaderModule(descriptor: GPUShaderModuleDescriptor): { code: string; label?: string } {
    return { code: descriptor.code, label: descriptor.label };
  }
  createComputePipeline(descriptor: { label?: string; compute: { module: { code: string }; entryPoint?: string } }) {
    const entry = descriptor.compute.entryPoint ?? 'main';
    const key = `${entry}\0${descriptor.compute.module.code}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const id = Number(this.call({ op: 'pipeline', code: descriptor.compute.module.code, entry, label: descriptor.label }));
      pipeline = { id, label: descriptor.label ?? '', getBindGroupLayout: (index: number) => ({ pipeline: id, index }) };
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
  createBindGroup(descriptor: { label?: string; layout: Layout; entries: Array<{ binding: number; resource: NativeResource | { buffer: NativeBuffer; offset?: number; size?: number } }> }): NativeResource {
    const entries = descriptor.entries.map(({ binding, resource }) => 'buffer' in resource
      ? { binding, id: resource.buffer.id, offset: resource.offset ?? 0, size: resource.size }
      : { binding, id: resource.id });
    const id = Number(this.call({ op: 'group', ...descriptor.layout, entries, label: descriptor.label }));
    this.temporary.add(id);
    return { id };
  }
  createTexture(descriptor: GPUTextureDescriptor): NativeTexture {
    const size = descriptor.size as GPUExtent3DDict | readonly number[];
    const width = 'width' in size ? size.width : size[0]!;
    const height = 'width' in size ? size.height ?? 1 : size[1] ?? 1;
    const id = Number(this.call({ op: 'texture', width, height, format: descriptor.format,
      usage: descriptor.usage, mips: descriptor.mipLevelCount ?? 1, label: descriptor.label }));
    return new NativeTexture(this, id, width, height);
  }
  createSampler(descriptor: GPUSamplerDescriptor = {}): NativeResource {
    if ([descriptor.magFilter, descriptor.minFilter, descriptor.mipmapFilter].some(filter => filter !== undefined && filter !== 'linear')) {
      throw new Error('Native lens sampler expects linear filters.');
    }
    return this.sampler ??= { id: Number(this.call({ op: 'sampler', label: descriptor.label })) };
  }
  createView(texture: number, descriptor: GPUTextureViewDescriptor = {}): NativeResource {
    const id = Number(this.call({ op: 'view', texture, baseMipLevel: descriptor.baseMipLevel ?? 0, mipLevelCount: descriptor.mipLevelCount }));
    this.temporary.add(id);
    return { id };
  }
  createCommandEncoder(): NativeEncoder { return new NativeEncoder(); }
  pushErrorScope(filter: GPUErrorFilter): void { this.scopes.push({ filter }); }
  async popErrorScope(): Promise<Error | null> { return this.scopes.pop()?.error ?? null; }
  /** Graphs must be disposed before trimming cached compiled pipelines. */
  releasePipelines(): void {
    for (const pipeline of this.pipelines.values()) this.call({ op: 'destroy', id: pipeline.id });
    this.pipelines.clear();
    if (this.sampler) this.call({ op: 'destroy', id: this.sampler.id });
    this.sampler = undefined;
  }
  asGpuDevice(): GPUDevice { return this as unknown as GPUDevice; }
}

class NativeBuffer implements NativeResource {
  readonly size: number;
  readonly usage: number;
  private mapped?: ArrayBuffer;
  private writeMapping: boolean;
  private destroyed = false;
  constructor(private readonly device: NativeGpuDevice, readonly id: number, descriptor: GPUBufferDescriptor) {
    this.size = descriptor.size;
    this.usage = descriptor.usage;
    this.writeMapping = descriptor.mappedAtCreation ?? false;
    if (this.writeMapping) this.mapped = new ArrayBuffer(this.size);
  }
  assertAlive(): void { if (this.destroyed) throw new Error('Native buffer is destroyed.'); }
  async mapAsync(mode: number, offset = 0, size = this.size - offset): Promise<void> {
    this.assertAlive();
    if (mode !== 1 || this.mapped) throw new Error('Invalid native buffer read mapping.');
    this.mapped = await this.device.host.read(this.id, offset, size);
    this.writeMapping = false;
  }
  getMappedRange(): ArrayBuffer {
    this.assertAlive();
    if (!this.mapped) throw new Error('Native buffer is not mapped.');
    return this.mapped;
  }
  unmap(): void {
    if (this.mapped && this.writeMapping) this.device.host.upload(this.id, 0, new Uint8Array(this.mapped));
    this.mapped = undefined;
    this.writeMapping = false;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.unmap();
    this.device.call({ op: 'destroy', id: this.id });
    this.destroyed = true;
  }
}

class NativeTexture implements NativeResource {
  private destroyed = false;
  constructor(private readonly device: NativeGpuDevice, readonly id: number, readonly width: number, readonly height: number) {}
  createView(descriptor?: GPUTextureViewDescriptor): NativeResource {
    if (this.destroyed) throw new Error('Native texture is destroyed.');
    return this.device.createView(this.id, descriptor);
  }
  destroy(): void {
    if (!this.destroyed) this.device.call({ op: 'destroy', id: this.id });
    this.destroyed = true;
  }
}

class NativeEncoder {
  private readonly commands: Command[] = [];
  private finished = false;
  beginComputePass() {
    if (this.finished) throw new Error('Native encoder is finished.');
    let pipeline: number | undefined;
    let group: number | undefined;
    let ended = false;
    return {
      setPipeline: (value: NativeResource) => { pipeline = value.id; },
      setBindGroup: (index: number, value: NativeResource) => {
        if (index !== 0) throw new Error('Canonical compute graph uses group 0.');
        group = value.id;
      },
      dispatchWorkgroups: (x: number, y = 1, z = 1) => {
        if (ended || pipeline === undefined || group === undefined) throw new Error('Invalid native compute pass.');
        this.commands.push({ op: 'dispatch', pipeline, group, x, y, z });
      },
      end: () => { ended = true; },
    };
  }
  copyBufferToBuffer(source: NativeResource, sourceOffset: number, dest: NativeResource, destOffset: number, size: number): void {
    if (this.finished) throw new Error('Native encoder is finished.');
    this.commands.push({ op: 'copy', source: source.id, sourceOffset, dest: dest.id, destOffset, size });
  }
  finish(): { commands: Command[] } {
    if (this.finished) throw new Error('Native encoder is finished.');
    this.finished = true;
    return { commands: this.commands };
  }
}
