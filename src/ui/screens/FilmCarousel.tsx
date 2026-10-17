/**
 * Pemilih film HP: carousel kartu berisi foto pengguna sendiri per stok,
 * plus baris kertas cetak di bawahnya. Kartu di tengah langsung dipratinjau
 * (seperti daftar stok: Cancel di sheet mengembalikan); hasil render tiap
 * stok disimpan sebagai gambar kartunya dan memudar masuk (crossfade) di atas
 * placeholder -- foto yang sama, hitam-putih dan redup -- untuk stok yang
 * belum pernah dikembangkan. Daftar lengkap (cari, semua detail) tetap ada di
 * balik tombol List.
 *
 * Gambar kartu = look LUT yang dipanggang (`engine/looks.ts`) diterapkan ke
 * foto asli -- semua kartu langsung terisi tanpa engine. Kombinasi tanpa LUT
 * (Film Off, LUT cetak) memakai frame pratinjau engine yang sudah tampil,
 * diingat per foto.
 *
 * Mode LUT: memilih kartu/kertas hanya mengubah `view` (resep tertunda di
 * Editor) dan foto editor menampilkan look-nya; engine baru mengembangkan
 * saat Done.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EngineState } from '../engine/engine';
import type { Frame } from '../engine/display';
import type { RenderParams } from '../../params/renderParams';
import { FILM_SECTIONS, PAPER_SECTIONS, isSlideFilm } from '../model/stocks';
import { isPrintLut } from '../../profiles/printLuts';
import { PROCESS_MODES } from '../model/tools';
import { Icon } from '../components/Icon';
import { PressButton, Segmented } from '../components/controls';
import { haptic } from '../haptics';
import type { StockKind } from './Stocks';
import { hasLook, loadLooks, lookFor, lookRenderer } from '../engine/looks';

/** Sisi panjang gambar kartu (px). */
const CARD_EDGE = 560;
/** Jeda setelah gulir berhenti sebelum stok di tengah diterapkan (ms). */
const SETTLE_MS = 140;

interface Card { id: string; brand: string; name: string; detail: string }

const CARDS: readonly Card[] = [
  { id: 'off', brand: 'Film', name: 'Off', detail: 'Neutral negative' },
  ...FILM_SECTIONS.filter((s) => !s.locked).flatMap((section) => section.stocks.map((stock) => ({
    id: stock.id,
    brand: section.scanOnly ? `${stock.name.split(' ')[0]} · Slide` : section.title,
    name: stock.short,
    detail: stock.detail,
  }))),
];

/** Kertas foto dan film cetak bioskop dulu, LUT cetak terakhir. */
const PAPERS = [...PAPER_SECTIONS.filter((s) => !s.locked && !s.title.startsWith('Film print LUTs')), ...PAPER_SECTIONS.filter((s) => !s.locked && s.title.startsWith('Film print LUTs'))]
  .flatMap((s) => s.stocks);

/** Gambar kartu per foto (Frame asli sebagai identitas foto), per resep. */
const snapshots = new WeakMap<Frame, Map<string, string>>();
/** Gambar kartu dari look LUT, per foto, per kunci look. */
const lookCards = new WeakMap<Frame, Map<string, string>>();

async function bitmapUrl(bitmap: ImageBitmap): Promise<string | undefined> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  return blob ? URL.createObjectURL(blob) : undefined;
}
const placeholders = new WeakMap<Frame, string>();

/** Kunci resep kartu film: film + apa yang membentuk tampilannya di sekitarnya. */
function cardKey(film: string, p: Pick<RenderParams, 'filmEnabled' | 'paper' | 'process'>): string {
  return `${film}|${p.paper}|${p.process}`;
}
function keyOf(p: RenderParams): string {
  return cardKey(p.filmEnabled ? p.film : 'off', p);
}

/** Frame -> URL JPEG kecil (async, di luar render). */
async function frameUrl(frame: Frame): Promise<string | undefined> {
  if (typeof document === 'undefined') return undefined;
  const scale = Math.min(1, CARD_EDGE / Math.max(frame.width, frame.height));
  const width = Math.max(1, Math.round(frame.width * scale)), height = Math.max(1, Math.round(frame.height * scale));
  const data = new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height, { colorSpace: frame.colorSpace });
  const bitmap = await createImageBitmap(data, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d', { colorSpace: frame.colorSpace })?.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  return blob ? URL.createObjectURL(blob) : undefined;
}

export function FilmCarousel({ state, view, onPick, onProcess, scan, previous, onList }: {
  state: EngineState;
  /** Resep yang dipilih di sheet (boleh belum dikirim ke engine). */
  view: RenderParams;
  onPick: (kind: StockKind, id: string) => void;
  onProcess: (process: string) => void;
  scan: boolean;
  previous?: { label: string; onSwap: () => void };
  onList: () => void;
}) {
  const { original, frame } = state;
  const params = view;
  const selected = params.filmEnabled ? params.film : 'off';
  const [, bump] = useState(0);
  const strip = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(() => Math.max(0, CARDS.findIndex((c) => c.id === selected)));
  const settle = useRef(0);
  /** Gulir oleh program (buka sheet, ketuk kartu, stok berubah di luar): jangan menerapkan ulang. */
  const programmatic = useRef(false);

  // Placeholder: foto asli, sekali per foto.
  useEffect(() => {
    if (!original || placeholders.has(original)) return;
    let live = true;
    void frameUrl(original).then((url) => {
      if (!url) return;
      placeholders.set(original, url);
      if (live) bump((n) => n + 1);
    });
    return () => { live = false; };
  }, [original]);

  // Frame pratinjau yang selesai (bukan frame ringan saat gesture) menjadi gambar kartunya.
  // `params` berganti seketika tetapi `rendering` baru menyala setelah worker
  // menerima patch: frame yang tampil saat resep berganti milik resep lama.
  const keyNow = keyOf(state.params);
  const lastKey = useRef(keyNow);
  const staleFrame = useRef<Frame | undefined>(undefined);
  if (lastKey.current !== keyNow) {
    lastKey.current = keyNow;
    staleFrame.current = frame;
  }
  useEffect(() => {
    if (!original || !frame || state.rendering || state.interacting || frame === staleFrame.current) return;
    const map = snapshots.get(original) ?? new Map<string, string>();
    snapshots.set(original, map);
    const key = keyNow;
    if (map.has(key)) return;
    let live = true;
    void frameUrl(frame).then((url) => {
      if (!url) return;
      // Resep sudah berganti selagi mengenkode: gambar ini milik resep lama, tetap benar untuk kuncinya.
      map.set(key, url);
      if (live) bump((n) => n + 1);
    });
    return () => { live = false; };
  }, [original, frame, state.rendering, state.interacting, keyNow]);

  // Kartu look: semua kartu diisi dari LUT, mulai dari yang di tengah lalu
  // tetangganya, satu per frame supaya gulir tetap mulus.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  useEffect(() => {
    if (!original) return undefined;
    let live = true;
    void (async () => {
      const r = lookRenderer();
      if (!(await loadLooks()) || !r || !live) return;
      r.setSource(original);
      const map = lookCards.get(original) ?? new Map<string, string>();
      lookCards.set(original, map);
      const scale = Math.min(1, CARD_EDGE / Math.max(original.width, original.height));
      const w = Math.round(original.width * scale), h = Math.round(original.height * scale);
      const at = focusedRef.current;
      const order = CARDS.map((c, i) => ({ c, d: Math.abs(i - at) })).sort((a, b) => a.d - b.d).map((x) => x.c);
      for (const card of order) {
        const look = lookFor(params, card.id);
        if (!look || !hasLook(look) || map.has(look)) continue;
        r.setSource(original);
        const bitmap = await r.apply(look, w, h);
        const url = bitmap ? await bitmapUrl(bitmap) : undefined;
        if (url) map.set(look, url);
        if (!live) return;
        bump((n) => n + 1);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    })();
    return () => { live = false; };
    // Kertas/proses yang dipilih menentukan look tiap kartu film.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, params.paper, params.process]);

  const scrollTo = (index: number, smooth: boolean) => {
    const el = strip.current?.children[index] as HTMLElement | undefined;
    const scroller = strip.current;
    if (!el || !scroller) return;
    programmatic.current = true;
    scroller.scrollTo({ left: el.offsetLeft + el.offsetWidth / 2 - scroller.clientWidth / 2, behavior: smooth ? 'smooth' : 'auto' });
  };

  // Buka: kartu terpilih di tengah tanpa animasi; stok berubah di luar (Swap, List): ikut.
  useLayoutEffect(() => {
    const i = CARDS.findIndex((c) => c.id === selected);
    if (i < 0) return;
    setFocused(i);
    scrollTo(i, false);
    // Hanya saat stok terpilih berubah.
  }, [selected]);

  const onScroll = () => {
    const scroller = strip.current;
    if (!scroller) return;
    const mid = scroller.scrollLeft + scroller.clientWidth / 2;
    let best = 0, dist = Infinity;
    Array.from(scroller.children).forEach((child, i) => {
      const el = child as HTMLElement;
      const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
      if (d < dist) { dist = d; best = i; }
    });
    if (best !== focused) {
      setFocused(best);
      if (!programmatic.current) haptic();
    }
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const wasProgrammatic = programmatic.current;
      programmatic.current = false;
      const card = CARDS[best];
      if (!wasProgrammatic && card && card.id !== selected) onPick('film', card.id);
    }, SETTLE_MS);
  };
  useEffect(() => () => window.clearTimeout(settle.current), []);

  const map = original ? snapshots.get(original) : undefined;
  const placeholder = original ? placeholders.get(original) : undefined;
  const aspect = original ? Math.min(1.5, Math.max(0.67, original.width / original.height)) : 1.5;
  const paperOff = (id: string) => (scan || !params.filmEnabled || isSlideFilm(params.film)) && !isPrintLut(id);
  const papers = useMemo(() => PAPERS, []);
  // Kertas terpilih terlihat di baris (tanpa menggulir halaman).
  const paperRow = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = paperRow.current, chip = row?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!row || !chip) return;
    const left = chip.offsetLeft - row.offsetLeft, right = left + chip.offsetWidth;
    if (left < row.scrollLeft || right > row.scrollLeft + row.clientWidth) row.scrollTo({ left: left - 16, behavior: 'smooth' });
  }, [params.paper]);

  return (
    <div className="film-carousel">
      <div className="film-carousel-top">
        <span className="film-carousel-process">
          <Segmented label="Process" items={PROCESS_MODES as readonly { value: string; label: string }[]} value={params.process} onChange={onProcess} small />
        </span>
        {previous && (
          <PressButton className="capsule bordered film-carousel-chip" onClick={previous.onSwap} aria-label={`Swap with previous stocks, ${previous.label}`}>
            <Icon name="compare" size={15} /> Swap
          </PressButton>
        )}
        <PressButton className="capsule bordered film-carousel-chip" onClick={onList} aria-label="Show all stocks as a list">
          <Icon name="search" size={15} /> List
        </PressButton>
      </div>

      <div
        ref={strip}
        className="film-strip"
        role="radiogroup"
        aria-label="Film"
        onScroll={onScroll}
        onPointerDown={() => { programmatic.current = false; }}
        onWheel={() => { programmatic.current = false; }}
        style={{ ['--card-aspect' as string]: aspect }}
      >
        {CARDS.map((card, i) => {
          const key = card.id === 'off' ? cardKey('off', params) : cardKey(card.id, params);
          const look = lookFor(params, card.id);
          const url = (look && original ? lookCards.get(original)?.get(look) : undefined) ?? map?.get(key);
          const isSelected = card.id === selected;
          return (
            <button
              key={card.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={`${card.brand} ${card.name}, ${card.detail}`}
              className="film-card"
              data-focused={i === focused || undefined}
              onClick={() => {
                if (i !== focused) { scrollTo(i, true); programmatic.current = false; return; }
                if (!isSelected) onPick('film', card.id);
              }}
            >
              <span className="film-card-photo">
                {placeholder && <img className="film-card-placeholder" src={placeholder} alt="" draggable={false} />}
                <AnimatePresence initial={false}>
                  {url && (
                    <motion.img
                      key={url}
                      className="film-card-image"
                      src={url}
                      alt=""
                      draggable={false}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.35, ease: 'easeOut' }}
                    />
                  )}
                </AnimatePresence>
                {i === focused && state.rendering && !url && <span className="film-card-developing">Developing…</span>}
              </span>
              <span className="film-card-label">
                <span className="film-card-brand">{card.brand}</span>
                <span className="film-card-name">{card.name}</span>
                <span className="film-card-detail">{card.detail}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="film-papers">
        <span className="film-papers-title">{scan ? 'Paper · not used when scanning' : 'Printed on'}</span>
        <div ref={paperRow} className="film-paper-row" role="radiogroup" aria-label="Paper">
          {papers.map((paper) => {
            const off = paperOff(paper.id);
            const on = paper.id === params.paper && !off;
            return (
              <button
                key={paper.id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={off}
                className="film-paper"
                title={paper.detail}
                onClick={() => onPick('paper', paper.id)}
              >
                {paper.short}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
