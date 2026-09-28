/**
 * Katalog stok untuk UI: nama tampilan, pengelompokan, dan keterangan satu
 * baris. Id dan jenisnya dijaga sama dengan `public/data/manifest.json` oleh
 * `test/ui/stocks.test.ts`, jadi thread UI tidak perlu mengunduh manifest
 * (140 KB) hanya untuk daftar nama.
 */

export interface StockInfo {
  id: string;
  /** Nama tanpa merek, untuk baris daftar yang sudah dikelompokkan per merek. */
  short: string;
  /** Nama lengkap, untuk judul dan status. */
  name: string;
  detail: string;
}

export interface StockSection {
  title: string;
  stocks: StockInfo[];
  /** Stok terlihat tetapi belum bisa dipilih (reversal: batch parameter 2). */
  locked?: boolean;
  footer?: string;
}

const s = (id: string, brand: string, short: string, detail: string): StockInfo => ({
  id,
  short,
  name: `${brand} ${short}`,
  detail,
});

export const FILM_SECTIONS: readonly StockSection[] = [
  {
    title: 'Kodak',
    stocks: [
      s('kodak_ektar_100', 'Kodak', 'Ektar 100', 'Color negative · ISO 100'),
      s('kodak_portra_160', 'Kodak', 'Portra 160', 'Color negative · ISO 160'),
      s('kodak_portra_400', 'Kodak', 'Portra 400', 'Color negative · ISO 400'),
      s('kodak_portra_800', 'Kodak', 'Portra 800', 'Color negative · ISO 800'),
      s('kodak_portra_800_push1', 'Kodak', 'Portra 800 Push 1', 'Pushed one stop · ISO 1600'),
      s('kodak_portra_800_push2', 'Kodak', 'Portra 800 Push 2', 'Pushed two stops · ISO 3200'),
      s('kodak_gold_200', 'Kodak', 'Gold 200', 'Color negative · ISO 200'),
      s('kodak_ultramax_400', 'Kodak', 'UltraMax 400', 'Color negative · ISO 400'),
      s('kodak_vision3_50d', 'Kodak', 'Vision3 50D', 'Motion picture · daylight'),
      s('kodak_vision3_250d', 'Kodak', 'Vision3 250D', 'Motion picture · daylight'),
      s('kodak_verita_200d', 'Kodak', 'Verita 200D', 'Motion picture · daylight'),
      s('kodak_vision3_200t', 'Kodak', 'Vision3 200T', 'Motion picture · tungsten'),
      s('kodak_vision3_500t', 'Kodak', 'Vision3 500T', 'Motion picture · tungsten'),
    ],
  },
  {
    title: 'Fujifilm',
    stocks: [
      s('fujifilm_pro_400h', 'Fujifilm', 'Pro 400H', 'Color negative · ISO 400'),
      s('fujifilm_c200', 'Fujifilm', 'C200', 'Color negative · ISO 200'),
      s('fujifilm_xtra_400', 'Fujifilm', 'X-TRA 400', 'Color negative · ISO 400'),
    ],
  },
  {
    title: 'Slide film',
    locked: true,
    footer: 'Slide films unlock once reversal processing is verified against the reference.',
    stocks: [
      s('kodak_ektachrome_100', 'Kodak', 'Ektachrome 100', 'Reversal · ISO 100'),
      s('kodak_kodachrome_64', 'Kodak', 'Kodachrome 64', 'Reversal · ISO 64'),
      s('fujifilm_velvia_100', 'Fujifilm', 'Velvia 100', 'Reversal · ISO 100'),
      s('fujifilm_provia_100f', 'Fujifilm', 'Provia 100F', 'Reversal · ISO 100'),
    ],
  },
];

export const PAPER_SECTIONS: readonly StockSection[] = [
  {
    title: 'Color paper',
    stocks: [
      s('kodak_portra_endura', 'Kodak', 'Portra Endura', 'Portrait paper'),
      s('kodak_endura_premier', 'Kodak', 'Endura Premier', 'Color paper'),
      s('kodak_ultra_endura', 'Kodak', 'Ultra Endura', 'Color paper'),
      s('kodak_supra_endura', 'Kodak', 'Supra Endura', 'Color paper'),
      s('kodak_ektacolor_edge', 'Kodak', 'Ektacolor Edge', 'Color paper'),
      s('fujifilm_crystal_archive_typeii', 'Fujifilm', 'Crystal Archive Type II', 'Color paper'),
    ],
  },
  {
    title: 'Cinema print film',
    stocks: [
      s('kodak_2383', 'Kodak', 'Vision 2383', 'Motion picture print'),
      s('kodak_2393', 'Kodak', 'Vision Premier 2393', 'Motion picture print'),
    ],
  },
];

const ALL = [...FILM_SECTIONS, ...PAPER_SECTIONS].flatMap((section) => section.stocks);

export function stockInfo(id: string): StockInfo {
  return ALL.find((stock) => stock.id === id) ?? { id, short: id, name: id, detail: '' };
}

/** Semua id yang bisa dipilih (tidak terkunci). */
export function selectableIds(sections: readonly StockSection[]): string[] {
  return sections.filter((section) => !section.locked).flatMap((section) => section.stocks.map((stock) => stock.id));
}

export function matchesQuery(stock: StockInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${stock.name} ${stock.detail}`.toLowerCase().includes(q);
}
