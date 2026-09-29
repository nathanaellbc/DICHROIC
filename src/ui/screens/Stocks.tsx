/**
 * Pemilih stok: film dan kertas, dikelompokkan per merek, dengan pencarian.
 * Dipakai di sheet (HP; pilihan langsung dipratinjau, Cancel mengembalikan)
 * dan di sidebar (layar lebar).
 */
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/controls';
import { FILM_SECTIONS, PAPER_SECTIONS, matchesQuery } from '../model/stocks';

export type StockKind = 'film' | 'paper';

export function StockBrowser({
  film,
  paper,
  onPick,
  kind,
  onKindChange,
  onBackground,
}: {
  film: string;
  paper: string;
  onPick: (kind: StockKind, id: string) => void;
  kind: StockKind;
  onKindChange: (kind: StockKind) => void;
  /** Daftar di atas latar gelap (sidebar) vs di sheet. */
  onBackground?: boolean;
}) {
  const [query, setQuery] = useState('');
  const sections = (kind === 'film' ? FILM_SECTIONS : PAPER_SECTIONS)
    .map((section) => ({ ...section, stocks: section.stocks.filter((s) => matchesQuery(s, query)) }))
    .filter((section) => section.stocks.length > 0);
  const chosen = kind === 'film' ? film : paper;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flexGrow: 1 }}>
      <div style={{ padding: '4px 16px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Segmented
          label="Stock type"
          items={[{ value: 'film', label: 'Film' }, { value: 'paper', label: 'Paper' }] as const}
          value={kind}
          onChange={onKindChange}
        />
        <label style={{ height: 40, borderRadius: 9999, background: 'var(--fill)', display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px' }}>
          <Icon name="search" size={17} color="rgba(235,235,245,0.6)" strokeWidth={2.2} />
          <span className="sr-only">Search stocks</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            enterKeyHint="search"
            style={{ flexGrow: 1, minWidth: 0, border: 0, background: 'transparent', outline: 'none', fontSize: '1rem' }}
          />
        </label>
      </div>
      <div className="scroll-y" style={{ flexGrow: 1, minHeight: 0, padding: '0 16px 32px', display: 'flex', flexDirection: 'column', gap: 22 }}>
        {sections.length === 0 && <p className="t-subhead secondary" style={{ textAlign: 'center', marginTop: 24 }}>No stocks match “{query}”.</p>}
        {query === '' && (
          <p className="t-footnote secondary" style={{ margin: '0 4px -8px' }}>
            {kind === 'film'
              ? 'Every negative is printed to a neutral grey, so films differ subtly: in color, contrast and grain. For a bigger change in look, try Paper.'
              : 'The paper sets contrast, color and the depth of the blacks. Cinema print films give the strongest look.'}
          </p>
        )}
        {sections.map((section) => (
          <section key={section.title} className="list-section">
            <h3 className="list-header">{section.title}</h3>
            <div className={onBackground ? 'list on-bg' : 'list'} role="radiogroup" aria-label={section.title}>
              {section.stocks.map((stock) => {
                const selected = !section.locked && stock.id === chosen;
                return (
                  <button
                    key={stock.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={section.locked}
                    className="row"
                    style={{ opacity: section.locked ? 0.55 : 1, minHeight: 60 }}
                    onClick={() => onPick(kind, stock.id)}
                  >
                    <span className="row-body">
                      <span className="row-text">
                        <span className="t-body">{kind === 'film' && section.locked ? stock.name : section.title === 'Kodak' || section.title === 'Fujifilm' ? stock.short : stock.name}</span>
                        <span className="t-subhead secondary">{stock.detail}</span>
                      </span>
                      {selected && <Icon name="check" size={20} color="#0091ff" strokeWidth={2.8} />}
                      {section.locked && <Icon name="lock" size={18} color="rgba(235,235,245,0.6)" />}
                    </span>
                  </button>
                );
              })}
            </div>
            {section.footer && <p className="list-footer t-footnote">{section.footer}</p>}
          </section>
        ))}
      </div>
    </div>
  );
}
