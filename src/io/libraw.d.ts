/**
 * Tipe minimal modul Emscripten `libraw-wasm/dist/libraw.js` (paket hanya
 * memberi tipe untuk pembungkus Worker `index.js`, yang tidak dipakai: ia
 * membuat Worker sendiri, sedangkan decode `io/` sudah berjalan di worker
 * `Session` dan juga harus jalan di Node).
 */
declare module 'libraw-wasm/dist/libraw.js' {
  export interface LibRawImage {
    width: number;
    height: number;
    colors: number;
    bits: number;
    data: Uint8Array | Uint16Array;
  }
  export interface LibRawInstance {
    open(bytes: Uint8Array, settings: Record<string, unknown>): void;
    imageData(): LibRawImage | undefined;
    delete(): void;
  }
  export interface LibRawModule {
    LibRaw: new () => LibRawInstance;
  }
  export interface LibRawFactoryOptions {
    wasmBinary?: ArrayBuffer | Uint8Array;
    print?: (text: string) => void;
    printErr?: (text: string) => void;
  }
  const factory: (options?: LibRawFactoryOptions) => Promise<LibRawModule>;
  export default factory;
}
