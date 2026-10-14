/**
 * ONNX Runtime for the native host: a minimal stand-in for the parts of the
 * onnxruntime-web API the depth and matte code uses (`Tensor`, `run`,
 * `release`), backed by the iOS ONNX Runtime through the host. The web's own
 * inference orchestration (depth refine, ViTMatte tiling) then runs unchanged.
 */

export interface NativeOrtHost {
  /** Opens a session; -1 when the model is not on the device and downloads are not allowed. */
  ortOpen(url: string, bytes: number, allowDownload: boolean, gpu: boolean): number;
  /** `{"inputs": [...], "outputs": [...]}` */
  ortNames(session: number): string;
  /** Runs feeds described by `meta` (name, type, dims) with `buffers` in order; returns output meta. */
  ortRun(session: number, meta: string, buffers: ArrayBufferView[]): string;
  /** Output `index` of the last run. */
  ortOutput(index: number): ArrayBuffer;
  ortClose(session: number): void;
}

/** The model is not on the device yet (the UI offers its download). */
export class ModelNotCachedError extends Error {
  readonly code = 'not-cached';
  constructor() { super('not-cached'); }
}

type TensorData = Float32Array | BigInt64Array;

export class NativeTensor {
  constructor(readonly type: 'float32' | 'int64', readonly data: TensorData, readonly dims: readonly number[]) {}
  getData(): Promise<TensorData> { return Promise.resolve(this.data); }
  dispose(): void {}
}

export interface NativeSession {
  readonly inputNames: string[];
  readonly outputNames: string[];
  run(feeds: Record<string, NativeTensor>): Promise<Record<string, NativeTensor>>;
  release(): Promise<void>;
}

export function openSession(host: NativeOrtHost, url: string, bytes: number, allowDownload: boolean, gpu: boolean): NativeSession {
  const id = host.ortOpen(url, bytes, allowDownload, gpu);
  if (id < 0) throw new ModelNotCachedError();
  const names = JSON.parse(host.ortNames(id)) as { inputs: string[]; outputs: string[] };
  let open = true;
  return {
    inputNames: names.inputs,
    outputNames: names.outputs,
    run(feeds) {
      if (!open) return Promise.reject(new Error('ONNX session is closed'));
      const entries = Object.entries(feeds);
      const meta = entries.map(([name, t]) => ({ name, type: t.type, dims: t.dims }));
      const outputs = JSON.parse(host.ortRun(id, JSON.stringify(meta), entries.map(([, t]) => t.data))) as Array<{ name: string; type: 'float32' | 'int64'; dims: number[] }>;
      const result: Record<string, NativeTensor> = {};
      outputs.forEach((o, i) => {
        const buffer = host.ortOutput(i);
        result[o.name] = new NativeTensor(o.type, o.type === 'int64' ? new BigInt64Array(buffer) : new Float32Array(buffer), o.dims);
      });
      return Promise.resolve(result);
    },
    release() {
      if (open) { open = false; host.ortClose(id); }
      return Promise.resolve();
    },
  };
}
