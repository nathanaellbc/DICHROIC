/**
 * Setiap sumber shader diimpor sebagai teks mentah lewat query `?raw` milik
 * Vite (dan Vitest, yang memakai pipeline transform Vite yang sama) — bukan
 * dievaluasi sebagai modul JS. TypeScript tidak tahu ekstensi ini secara
 * bawaan, jadi deklarasi ambient ini adalah satu-satunya sumber tipe untuk
 * `import source from '../../shaders/x.wgsl?raw'` di seluruh paket.
 */
declare module '*.wgsl?raw' {
  const content: string;
  export default content;
}
