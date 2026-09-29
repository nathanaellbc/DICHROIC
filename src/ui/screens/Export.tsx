/**
 * Ekspor: gambar (PNG 8/16, TIFF 16) dari render resolusi penuh, atau LUT
 * `.cube`. Satu aksi utama di bawah; hasilnya diserahkan lewat lembar Bagikan
 * (HP) atau unduhan (desktop).
 */
import { useState } from 'react';
import type { ExportFormat } from '../../session/session';
import { Icon } from '../components/Icon';
import { PressButton, Segmented } from '../components/controls';
import { Spinner } from '../components/Overlays';
import { engine } from '../engine/engine';
import { isDisplayReferred } from '../engine/display';
import { deliverFile } from '../share';

const FORMATS: ReadonlyArray<{ value: ExportFormat; name: string; hint: string }> = [
  { value: 'png8', name: 'PNG 8-bit', hint: 'For the web and sharing' },
  { value: 'png16', name: 'PNG 16-bit', hint: 'Smooth gradients, still lossless' },
  { value: 'tiff16', name: 'TIFF 16-bit', hint: 'For further editing, uncompressed' },
];
const CUBE_SIZES = [{ value: '17', label: '17' }, { value: '33', label: '33' }, { value: '65', label: '65' }] as const;

export function ExportContent({
  outputColorSpace,
  inputColorSpace,
  onDone,
  onError,
}: {
  outputColorSpace: string;
  inputColorSpace: string;
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}) {
  const [mode, setMode] = useState<'image' | 'cube'>('image');
  const [format, setFormat] = useState<ExportFormat>('png8');
  const [cubeSize, setCubeSize] = useState<'17' | '33' | '65'>('33');
  const [busy, setBusy] = useState(false);
  const formatName = FORMATS.find((f) => f.value === format)!.name;

  const run = async () => {
    setBusy(true);
    try {
      const file = mode === 'image' ? await engine.exportImage(format) : await engine.exportCube(Number(cubeSize));
      const result = await deliverFile(file);
      const limited = mode === 'image' ? engine.lastExportLimited : undefined;
      const note = limited ? ` at ${limited.width} × ${limited.height} (diffusion filter size limit)` : '';
      if (result !== 'cancelled') onDone(result === 'shared' ? `Exported${note}` : `Saved ${file.name}${note}`);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flexGrow: 1 }}>
      <div className="scroll-y" style={{ flexGrow: 1, minHeight: 0, padding: '4px 16px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Segmented label="Export type" items={[{ value: 'image', label: 'Image' }, { value: 'cube', label: 'LUT (.cube)' }] as const} value={mode} onChange={setMode} />

        {mode === 'image' ? (
          <>
            <div className="list" role="radiogroup" aria-label="Format">
              {FORMATS.map((f) => (
                <button key={f.value} type="button" role="radio" aria-checked={f.value === format} className="row" style={{ minHeight: 60 }} onClick={() => setFormat(f.value)}>
                  <span className="row-body">
                    <span className="row-text">
                      <span className="t-body">{f.name}</span>
                      <span className="t-subhead secondary">{f.hint}</span>
                    </span>
                    {f.value === format && <Icon name="check" size={20} color="#0091ff" strokeWidth={2.8} />}
                  </span>
                </button>
              ))}
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
                Rendered again at full resolution. No ICC profile is embedded yet, so other apps read the file as {isDisplayReferred(outputColorSpace) ? 'sRGB' : 'untagged RGB'}. Change the color space in Color › Output.
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
            <div style={{ borderRadius: 20, background: 'rgba(255,146,48,0.14)', padding: '12px 16px', display: 'flex', gap: 10 }}>
              <span style={{ flexShrink: 0, color: '#ffa056' }}><Icon name="info" size={20} /></span>
              <span className="t-subhead" style={{ color: 'rgba(255,232,214,0.92)' }}>
                A LUT carries color only. Grain, halation, glare and sharpening are left out, and film and print exposure are ignored.
              </span>
            </div>
          </>
        )}
      </div>
      <div style={{ padding: '12px 16px 16px', flexShrink: 0 }}>
        <PressButton className="capsule prominent large" disabled={busy} onClick={run}>
          {busy ? (
            <>
              <Spinner size={18} /> {mode === 'image' ? 'Developing full size…' : 'Building LUT…'}
            </>
          ) : mode === 'image' ? (
            `Export ${formatName}`
          ) : (
            `Export ${cubeSize}³ LUT`
          )}
        </PressButton>
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
                  {o.value === value && <Icon name="check" size={20} color="#0091ff" strokeWidth={2.8} />}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
