/**
 * Pemilih stok: film dan kertas, dikelompokkan per merek, dengan pencarian,
 * plus Process (Print/Scan) -- pilihan yang menentukan apakah kertas berlaku,
 * jadi letaknya di sini, bukan terkubur di alat Film. Dipakai di sheet (HP;
 * pilihan langsung dipratinjau, Cancel mengembalikan, Swap membandingkan
 * dengan pilihan sebelumnya) dan sebagai source list sidebar (layar lebar,
 * `dense`: baris rapat, pilihan berisi biru, seperti sidebar macOS).
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { PressButton, Segmented } from '../components/controls';
import { PROCESS_MODES } from '../model/tools';
import { FILM_SECTIONS, PAPER_SECTIONS, matchesQuery } from '../model/stocks';
import type { StockInfo, StockSection } from '../model/stocks';

export type StockKind = 'film' | 'paper';

/** Nama baris: tanpa merek di bawah judul merek (Kodak, Fujifilm). */
function rowName(kind: StockKind, section: StockSection, stock: StockInfo): string {
  if (kind === 'film' && section.locked) return stock.name;
  return section.title === 'Kodak' || section.title === 'Fujifilm' ? stock.short : stock.name;
}

export function StockBrowser({
  film,
  filmEnabled = true,
  paper,
  onPick,
  kind,
  onKindChange,
  dense = false,
  scan = false,
  process,
  onProcess,
  previous,
  revealToken,
}: {
  film: string;
  filmEnabled?: boolean;
  paper: string;
  onPick: (kind: StockKind, id: string) => void;
  kind: StockKind;
  onKindChange: (kind: StockKind) => void;
  /** Source list sidebar (layar lebar) vs daftar grouped di sheet. */
  dense?: boolean;
  /** Fase 2D: mode scan -- tidak ada kertas; daftar kertas dinonaktifkan. */
  scan?: boolean;
  process: string;
  onProcess: (process: string) => void;
  /** Stok sebelum sheet dibuka (atau sebelum Swap terakhir): A/B satu ketukan. */
  previous?: { label: string; onSwap: () => void };
  /** Bertambah = gulir ke stok terpilih (path control toolbar). */
  revealToken?: number;
}) {
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const sections = (kind === 'film' ? FILM_SECTIONS : PAPER_SECTIONS)
    .map((section) => ({ ...section, stocks: section.stocks.filter((s) => matchesQuery(s, query)) }))
    .filter((section) => section.stocks.length > 0);
  const chosen = kind === 'film' ? film : paper;

  useEffect(() => {
    if (!revealToken) return;
    setQuery('');
    const scroller = scrollRef.current;
    const row = scroller?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!scroller || !row) return;
    const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientHeight / 2 + row.offsetHeight / 2;
    scroller.scrollTo({ top, behavior: 'smooth' });
    row.focus({ preventScroll: true });
  }, [revealToken, kind]);

  const hint = query === '' && (
    <p className="t-footnote secondary" style={{ margin: dense ? '4px 8px 2px' : '0 4px -8px' }}>
      {!filmEnabled && kind === 'paper' ? 'Paper is bypassed while Film is Off. Select a film to enable it again.' : kind === 'film'
        ? !filmEnabled
          ? 'Film and paper are off. Camera and Lens adjustments remain active.'
          : scan
          ? 'Scanning shows the film itself. Slides come out as positives; color negatives come out orange and inverted.'
          : 'Every negative is printed to a neutral grey, so films differ subtly: in color, contrast and grain. For a bigger change in look, try Paper.'
        : scan
          ? 'Nothing is printed while Process is set to Scan. Set Process to Print above to use paper.'
          : 'The paper sets contrast, color and the depth of the blacks. Cinema print films give the strongest look.'}
    </p>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flexGrow: 1 }}>
      <div style={{ padding: dense ? '0 12px 10px' : '4px 16px 12px', display: 'flex', flexDirection: 'column', gap: dense ? 10 : 12, borderBottom: dense ? '1px solid var(--hairline)' : undefined }}>
        <Segmented
          label="Stock type"
          items={[{ value: 'film', label: 'Film' }, { value: 'paper', label: 'Paper' }] as const}
          value={kind}
          onChange={onKindChange}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: dense ? '0 2px' : '0 4px' }}>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span className={dense ? 't-body' : 't-subhead'} style={{ fontWeight: 600 }}>Process</span>
            <span className="t-footnote secondary">{!filmEnabled ? 'Film and paper bypassed' : scan ? 'The film itself, no paper' : 'Film printed onto paper'}</span>
          </span>
          <span style={{ width: dense ? 112 : 150, flexShrink: 0 }}>
            <Segmented label="Process" items={PROCESS_MODES as readonly { value: string; label: string }[]} value={process} onChange={onProcess} small />
          </span>
        </div>
        {previous && (
          <div style={{ borderRadius: 'var(--r-list)', background: 'var(--bg-elevated-2)', padding: '6px 6px 6px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="t-footnote" style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span className="secondary">Previous</span>
              <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{previous.label}</span>
            </span>
            <PressButton className="capsule bordered" style={{ height: 34, padding: '0 12px', fontSize: '0.882rem' }} onClick={previous.onSwap} aria-label={`Swap with previous stocks, ${previous.label}`}>
              <Icon name="compare" size={16} /> Swap
            </PressButton>
          </div>
        )}
        <label className="search-field">
          <Icon name="search" size={dense ? 13 : 16} color="var(--label-2)" strokeWidth={2.2} />
          <span className="sr-only">Search stocks</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" enterKeyHint="search" />
        </label>
      </div>
      <div
        ref={scrollRef}
        className="scroll-y"
        style={{ flexGrow: 1, minHeight: 0, padding: dense ? '4px 8px 16px' : '0 16px 32px', display: 'flex', flexDirection: 'column', gap: dense ? 0 : 20 }}
      >
        {sections.length === 0 && <p className="t-subhead secondary" style={{ textAlign: 'center', marginTop: 24 }}>No stocks match “{query}”.</p>}
        {kind === 'film' && !query && <div className={dense ? 'source-list' : 'list'} role="radiogroup" aria-label="Film bypass">
          <button type="button" role="radio" aria-checked={!filmEnabled} className={dense ? 'source-row' : 'row'} style={dense ? undefined : { minHeight: 56 }} onClick={() => onPick('film', 'off')}>
            <span className={dense ? 'name' : 'row-body'}>Off</span>
            <span className="meta secondary">Camera &amp; Lens only</span>
            {!dense && !filmEnabled && <Icon name="check" size={20} color="var(--blue)" />}
          </button>
        </div>}
        {hint}
        {sections.map((section) => {
          const paperOff = kind === 'paper' && (scan || !filmEnabled);
          return (
            <section key={section.title} className={dense ? undefined : 'list-section'}>
              <h3 className={dense ? 'source-header' : 'list-header'}>{section.title}</h3>
              <div className={dense ? 'source-list' : 'list'} role="radiogroup" aria-label={section.title}>
                {section.stocks.map((stock) => {
                  const selected = !section.locked && stock.id === chosen && !paperOff && (kind !== 'film' || filmEnabled);
                  const disabled = section.locked || paperOff;
                  const name = rowName(kind, section, stock);
                  return dense ? (
                    <button
                      key={stock.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={disabled}
                      className="source-row"
                      title={`${stock.name} · ${stock.detail}`}
                      onClick={() => onPick(kind, stock.id)}
                    >
                      <span className="name">{name}</span>
                      <span className="meta secondary">{section.locked ? <Icon name="lock" size={11} /> : stock.detail.split(' · ').pop()}</span>
                    </button>
                  ) : (
                    <button
                      key={stock.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={disabled}
                      className="row"
                      style={{ opacity: disabled ? 0.45 : 1, minHeight: 56 }}
                      onClick={() => onPick(kind, stock.id)}
                    >
                      <span className="row-body">
                        <span className="row-text">
                          <span className="t-body">{name}</span>
                          <span className="t-subhead secondary">{stock.detail}</span>
                        </span>
                        {selected && <Icon name="check" size={20} color="var(--blue)" strokeWidth={2.8} />}
                        {section.locked && <Icon name="lock" size={18} color="var(--label-2)" />}
                      </span>
                    </button>
                  );
                })}
              </div>
              {section.footer && <p className="list-footer t-footnote" style={dense ? { padding: '4px 8px 0' } : undefined}>{section.footer}</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
