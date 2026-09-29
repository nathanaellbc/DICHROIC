/**
 * Ekspor, dengan disiplin lembar ekspor EMULSION (ditulis ulang untuk
 * DICHROIC):
 *
 *  - Format ditawarkan hanya bila browser ini benar-benar menghasilkannya:
 *    PNG 8/16 dan TIFF 16 dari encoder kita sendiri (selalu), JPEG/WebP/AVIF
 *    dari encoder kanvas worker setelah lolos probing.
 *  - Sisi panjang berupa detent yang sungguh memperkecil (2048/4096/8192) plus
 *    "Source"; tidak pernah memperbesar. Efek berukuran fisik dirender ulang
 *    pada pitch piksel itu, bukan di-resize.
 *  - Render dan encode berjalan SELAGI pengaturan dipilih: tombol simpan
 *    langsung aktif, `navigator.share` (yang di iOS wajib di dalam gestur)
 *    menerima berkas yang sudah ada, dan ukuran berkas yang ditampilkan adalah
 *    ukuran TERUKUR, bukan perkiraan.
 *  - Pilihan disimpan di `localStorage`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExportFormat } from '../../session/session';
import { Icon } from '../components/Icon';
import { PressButton, Segmented, Slider } from '../components/controls';
import { Spinner } from '../components/Overlays';
import { engine } from '../engine/engine';
import { canvasLimits, longEdgeDetents } from '../model/exportSizes';
import { formatBytes, prefersShareSheet, saveViaDownload, saveViaShare } from '../share';

interface Failure {
  /** Apa yang terjadi dan apa yang bisa dicoba, untuk pengguna. */
  text: string;
  /** Pesan teknis aslinya, kecil di bawahnya (untuk laporan bug). */
  detail: string;
}

function failureOf(error: unknown, what: 'image' | 'cube'): Failure {
  return {
    text: what === 'cube'
      ? 'Couldn’t build the LUT. Try a smaller cube size.'
      : 'Couldn’t prepare the file. Try a smaller long edge or another format; your edits are kept.',
    detail: error instanceof Error ? error.message : String(error),
  };
}

const FORMAT_INFO: Record<ExportFormat, { name: string; hint: string; lossy: boolean }> = {
  png8: { name: 'PNG 8-bit', hint: 'Lossless · every pixel as rendered', lossy: false },
  png16: { name: 'PNG 16-bit', hint: 'Lossless · smooth gradients', lossy: false },
  tiff16: { name: 'TIFF 16-bit', hint: 'Uncompressed · for further editing', lossy: false },
  jpeg: { name: 'JPEG', hint: 'Lossy · smallest widely compatible file', lossy: true },
  webp: { name: 'WebP', hint: 'Lossy · smaller than JPEG at like quality', lossy: true },
  avif: { name: 'AVIF', hint: 'Lossy · smallest file, slowest to encode', lossy: true },
};
const CUBE_SIZES = [{ value: '17', label: '17' }, { value: '33', label: '33' }, { value: '65', label: '65' }] as const;

/** Bawaan format lossy: tanpa artefak yang terlihat, jauh lebih kecil dari 100. */
const DEFAULT_QUALITY = 92;
const STORAGE_KEY = 'dichroic.export.v1';

interface ExportPrefs {
  format: ExportFormat;
  /** 1..100, hanya format lossy. */
  quality: number;
  /** `null` = ukuran sumber. */
  longEdge: number | null;
}

function loadPrefs(): ExportPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ExportPrefs>;
      return {
        format: p.format && p.format in FORMAT_INFO ? p.format : 'png8',
        quality: typeof p.quality === 'number' ? Math.min(100, Math.max(1, Math.round(p.quality))) : DEFAULT_QUALITY,
        longEdge: typeof p.longEdge === 'number' ? p.longEdge : null,
      };
    }
  } catch {
    // Preferensi tersimpan yang rusak tidak sepadan dengan ekspor yang gagal.
  }
  return { format: 'png8', quality: DEFAULT_QUALITY, longEdge: null };
}

export function ExportContent({
  outputColorSpace,
  inputColorSpace,
  recipe,
  onDone,
  onCancel,
  onError,
}: {
  /** Tutup tanpa menyimpan (tombol Cancel dialog desktop). */
  onCancel: () => void;
  outputColorSpace: string;
  inputColorSpace: string;
  /** Stok foto ini ("Portra 400 on Portra Endura"), untuk konfirmasi akhir. */
  recipe: string;
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const [mode, setMode] = useState<'image' | 'cube'>('image');
  const [formats, setFormats] = useState<ExportFormat[] | null>(null);
  const [prefs, setPrefs] = useState<ExportPrefs>(loadPrefs);
  const [cubeSize, setCubeSize] = useState<'17' | '33' | '65'>('33');
  const [rendered, setRendered] = useState<{ width: number; height: number; limited: boolean; request: number | undefined } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [cubeFile, setCubeFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const shareable = useMemo(prefersShareSheet, []);

  const format: ExportFormat = formats?.includes(prefs.format) ? prefs.format : 'png8';
  const info = FORMAT_INFO[format];
  const source = engine.imageSize ?? { width: 1, height: 1 };
  const detents = useMemo(
    () => longEdgeDetents(source.width, source.height, info.lossy ? canvasLimits() : undefined),
    [source.width, source.height, info.lossy],
  );
  const selected = detents.find((d) => d.longEdge === prefs.longEdge) ?? detents[detents.length - 1]!;
  const request = selected.request;
  const rendering = mode === 'image' && (rendered === null || rendered.request !== request);

  // Seperti EMULSION: render ekspor hanya dipegang selama lembar ini terbuka.
  useEffect(() => () => engine.releaseExport(), []);

  useEffect(() => {
    let alive = true;
    engine.exportFormats().then(
      (f) => alive && setFormats(f),
      () => alive && setFormats(['png8', 'png16', 'tiff16']),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Preferensi yang tidak tersimpan hanya gangguan kecil.
    }
  }, [prefs]);

  // Fase 1, render: saat dibuka dan saat sisi panjang berubah (debounce,
  // supaya worker tidak merender tiap detent yang dilewati).
  useEffect(() => {
    if (mode !== 'image') return;
    let alive = true;
    setFile(null);
    const t = window.setTimeout(() => {
      engine.renderExport(request, selected).then(
        (size) => {
          if (!alive) return;
          setRendered({ ...size, request });
          setFailure(null);
        },
        (error: unknown) => alive && setFailure(failureOf(error, 'image')),
      );
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // `selected` berubah identitas tiap render; `request` sudah mewakilinya.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, request]);

  // Fase 2, encode: setelah render mendarat, dan saat format/kualitas
  // bergeser -- tanpa kerja GPU (render diambil dari cache `Session`).
  useEffect(() => {
    if (mode !== 'image' || rendering || !formats) return;
    let alive = true;
    setEncoding(true);
    const t = window.setTimeout(() => {
      engine.exportImage(format, { longEdge: request, quality: prefs.quality / 100 }).then(
        (f) => {
          if (!alive) return;
          setFile(f);
          setEncoding(false);
          setFailure(null);
        },
        (error: unknown) => {
          if (!alive) return;
          setFile(null);
          setEncoding(false);
          setFailure(failureOf(error, 'image'));
        },
      );
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [mode, rendering, formats, format, request, prefs.quality]);

  useEffect(() => {
    if (mode !== 'cube') return;
    let alive = true;
    setCubeFile(null);
    engine.exportCube(Number(cubeSize)).then(
      (f) => alive && setCubeFile(f),
      (error: unknown) => alive && setFailure(failureOf(error, 'cube')),
    );
    return () => {
      alive = false;
    };
  }, [mode, cubeSize]);

  const ready = mode === 'image' ? (!rendering && !encoding ? file : null) : cubeFile;
  const limitedNote = mode === 'image' && rendered?.limited ? ` at ${rendered.width} × ${rendered.height} (diffusion filter size limit)` : '';

  // Keduanya menerima berkas yang SUDAH ada: tidak ada `await` antara
  // ketukan dan `navigator.share` (syarat iOS).
  const doShare = () => {
    if (!ready) return;
    saveViaShare(ready).then(
      (result) => result === 'shared' && onDone(`Exported · ${recipe}${limitedNote}`),
      onError,
    );
  };
  const doDownload = () => {
    if (!ready) return;
    try {
      saveViaDownload(ready);
      onDone(`Saved · ${recipe}${limitedNote}`);
    } catch (error) {
      onError(error);
    }
  };

  // Dialog desktop: Return menjalankan tombol bawaan (Download / Save), kecuali
  // fokus sedang di kontrol lain yang memakai Enter sendiri.
  const primary = shareable ? doShare : doDownload;
  const primaryRef = useRef(primary);
  useEffect(() => {
    primaryRef.current = primary;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || document.documentElement.dataset.size !== 'regular') return;
      const active = document.activeElement;
      if (active && active.matches('button, input, select, textarea, [role=slider]')) return;
      e.preventDefault();
      primaryRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const sizeLabel = ready ? formatBytes(ready.size) : '';
  const busyLabel = mode === 'cube' ? 'Building LUT…' : rendering ? 'Developing…' : 'Encoding…';
  const busy = !ready && !failure;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flexGrow: 1 }}>
      <div className="scroll-y" style={{ flexGrow: 1, minHeight: 0, padding: '4px 16px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Segmented label="Export type" items={[{ value: 'image', label: 'Image' }, { value: 'cube', label: 'LUT (.cube)' }] as const} value={mode} onChange={setMode} />

        {mode === 'image' ? (
          <>
            {formats ? (
              <div className="list" role="radiogroup" aria-label="Format">
                {formats.map((f) => (
                  <button key={f} type="button" role="radio" aria-checked={f === format} className="row" style={{ minHeight: 56 }} onClick={() => setPrefs((p) => ({ ...p, format: f }))}>
                    <span className="row-body">
                      <span className="row-text">
                        <span className="t-body">{FORMAT_INFO[f].name}</span>
                        <span className="t-subhead secondary">{FORMAT_INFO[f].hint}</span>
                      </span>
                      {f === format && <Icon name="check" size={20} color="var(--blue)" strokeWidth={2.8} />}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="t-footnote secondary" style={{ margin: 0 }}>Checking what this browser can encode…</p>
            )}

            {info.lossy && (
              <div className="list-section">
                <h3 className="list-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Quality</span>
                  <span className="num">{prefs.quality} · {encoding || rendering ? 'measuring…' : sizeLabel || '—'}</span>
                </h3>
                <Slider
                  label="Quality"
                  value={prefs.quality}
                  min={1}
                  max={100}
                  step={1}
                  defaultValue={DEFAULT_QUALITY}
                  valueText={`${prefs.quality}`}
                  onChange={(v) => setPrefs((p) => ({ ...p, quality: Math.round(v) }))}
                />
                <p className="list-footer t-footnote">The size is measured, not estimated: the file is encoded again as the slider settles.</p>
              </div>
            )}

            <div className="list-section">
              <h3 className="list-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Long edge</span>
                <span className="num">{selected.width} × {selected.height} px</span>
              </h3>
              {detents.length > 1 ? (
                <Segmented
                  label="Long edge"
                  items={detents.map((d) => ({ value: String(d.longEdge), label: d.label }))}
                  value={String(selected.longEdge)}
                  onChange={(v) => setPrefs((p) => ({ ...p, longEdge: v === 'null' ? null : Number(v) }))}
                />
              ) : (
                // Satu ukuran saja (foto sudah kecil): nilai tetap, bukan kontrol.
                <div className="list">
                  <div className="row-static">
                    <span className="row-body" style={{ justifyContent: 'space-between' }}>
                      <span className="t-body">{selected.label}</span>
                      <span className="t-body secondary">No smaller sizes</span>
                    </span>
                  </div>
                </div>
              )}
              <p className="list-footer t-footnote">
                Grain, halation and diffusion are physical sizes, so a smaller export is developed again at its own pixel pitch rather than resized.
              </p>
            </div>

            <div className="list-section">
              <div className="list">
                <div className="row-static">
                  <span className="row-body" style={{ justifyContent: 'space-between' }}>
                    <span className="t-body">Color Space</span>
                    <span className="t-body secondary">{outputColorSpace}</span>
                  </span>
                </div>
              </div>
              <p className="list-footer t-footnote">
                {format === 'webp' || format === 'avif'
                  ? `Tagged ${outputColorSpace === 'Display P3' ? 'Display P3' : 'sRGB'} by the browser’s encoder; camera EXIF isn’t carried in ${info.name}.`
                  : `Embeds the ${outputColorSpace} ICC profile, and the camera EXIF when the original has it.`}{' '}
                Change the color space in Color › Output.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="list-section">
              <h3 className="list-header">Cube size</h3>
              <Segmented label="Cube size" items={CUBE_SIZES} value={cubeSize} onChange={setCubeSize} />
            </div>
            <div className="list">
              <div className="row-static">
                <span className="row-body" style={{ justifyContent: 'space-between', gap: 16 }}>
                  <span className="t-body">Converts</span>
                  <span className="t-subhead secondary" style={{ textAlign: 'right' }}>{inputColorSpace} → {outputColorSpace}</span>
                </span>
              </div>
            </div>
            <div className="callout warn">
              <span style={{ flexShrink: 0, color: 'var(--orange)' }}><Icon name="info" size={20} /></span>
              <span className="t-subhead" style={{ color: 'rgba(255,236,220,0.94)' }}>
                A LUT carries color only. Grain, halation, glare, diffusion, lens blur and sharpening are left out, and film and print exposure are ignored.
              </span>
            </div>
          </>
        )}

        {failure && (
          <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <p className="t-footnote" style={{ margin: 0, color: 'var(--red-text)', fontWeight: 600 }}>{failure.text}</p>
            <p className="t-caption secondary" style={{ margin: 0 }}>{failure.detail}</p>
          </div>
        )}
        <p className="t-footnote secondary num" style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ready?.name}>
          {ready?.name ?? ' '}
        </p>
      </div>
      <div className="sheet-actions">
        <PressButton className="capsule large dialog-only" aria-keyshortcuts="Escape" onClick={onCancel}>
          Cancel
        </PressButton>
        {shareable ? (
          <>
            <PressButton className="capsule bordered large" style={{ flex: '0 0 38%' }} disabled={!ready} onClick={doDownload}>
              Download
            </PressButton>
            <PressButton className="capsule prominent large" disabled={!ready} onClick={doShare}>
              {busy ? (
                <>
                  <Spinner size={18} /> {busyLabel}
                </>
              ) : (
                'Save to Photos'
              )}
            </PressButton>
          </>
        ) : (
          <PressButton className="capsule prominent large" disabled={!ready} onClick={doDownload}>
            {busy ? (
              <>
                <Spinner size={18} /> {busyLabel}
              </>
            ) : sizeLabel ? (
              `Download · ${sizeLabel}`
            ) : (
              'Download'
            )}
          </PressButton>
        )}
      </div>
    </div>
  );
}

/** Daftar pilihan panjang (colour space input), dikelompokkan. */
export function ListPickerContent({
  options,
  value,
  onPick,
}: {
  options: ReadonlyArray<{ value: string; label: string; group?: string }>;
  value: string;
  onPick: (value: string) => void;
}) {
  const groups = [...new Set(options.map((o) => o.group ?? ''))];
  return (
    <div className="scroll-y" style={{ flexGrow: 1, minHeight: 0, padding: '4px 16px 32px', display: 'flex', flexDirection: 'column', gap: 22 }}>
      {groups.map((group) => (
        <section key={group} className="list-section">
          {group && <h3 className="list-header">{group}</h3>}
          <div className="list" role="radiogroup" aria-label={group || 'Options'}>
            {options.filter((o) => (o.group ?? '') === group).map((o) => (
              <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className="row" onClick={() => onPick(o.value)}>
                <span className="row-body">
                  <span className="row-text"><span className="t-body">{o.label}</span></span>
                  {o.value === value && <Icon name="check" size={20} color="var(--blue)" strokeWidth={2.8} />}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
