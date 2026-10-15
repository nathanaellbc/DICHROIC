/**
 * All Projects (sheet): semua proyek, dikelompokkan per hari dan bisa dicari
 * (pola "Chat history"). Ketuk untuk membuka; ⋯ atau klik kanan untuk
 * Rename, Duplicate, Delete. Rename terjadi langsung di baris.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { PressButton } from '../components/controls';
import type { ProjectCard } from '../projects/projects';
import { dayGroup, recipeText, relativeTime, shortTime } from '../projects/format';

const GROUPS = ['Today', 'Yesterday', 'This Week', 'Earlier'] as const;

export function ProjectsContent({ cards, renaming, onOpen, onRelink, onMenu, onRename, onCancelRename, usage }: {
  cards: readonly ProjectCard[];
  /** Proyek yang sedang di-rename di barisnya. */
  renaming?: string;
  onOpen: (card: ProjectCard) => void;
  onRelink: (card: ProjectCard) => void;
  onMenu: (card: ProjectCard, anchor: DOMRect) => void;
  onRename: (card: ProjectCard, name: string) => void;
  onCancelRename: () => void;
  usage?: string;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? cards.filter((c) => `${c.name} ${c.fileName} ${recipeText(c.params)}`.toLowerCase().includes(q)) : cards;
  const now = Date.now();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flexGrow: 1 }}>
      <div style={{ padding: '4px 16px 10px' }}>
        <label className="search-field">
          <Icon name="search" size={16} color="var(--label-2)" strokeWidth={2.2} />
          <span className="sr-only">Search projects</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" enterKeyHint="search" />
        </label>
      </div>
      <div className="scroll-y" style={{ flexGrow: 1, minHeight: 0, padding: '0 16px 32px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {shown.length === 0 && <p className="t-subhead secondary" style={{ textAlign: 'center', marginTop: 24 }}>{q ? `No projects match “${query}”.` : 'No projects yet.'}</p>}
        {GROUPS.map((group) => {
          const rows = shown.filter((c) => dayGroup(c.updatedAt, now) === group);
          if (rows.length === 0) return null;
          return (
            <section key={group} className="list-section">
              <h3 className="list-header">{group}</h3>
              <div className="list" role="list" aria-label={group}>
                {rows.map((c) => (
                  <ProjectRow
                    key={c.id}
                    card={c}
                    renaming={renaming === c.id}
                    onOpen={() => (c.missing ? onRelink(c) : onOpen(c))}
                    onMenu={(rect) => onMenu(c, rect)}
                    onRename={(name) => onRename(c, name)}
                    onCancelRename={onCancelRename}
                  />
                ))}
              </div>
            </section>
          );
        })}
        {usage && <p className="t-footnote secondary tabular" style={{ margin: '0 4px' }}>{usage}</p>}
      </div>
    </div>
  );
}

function ProjectRow({ card, renaming, onOpen, onMenu, onRename, onCancelRename }: {
  card: ProjectCard;
  renaming: boolean;
  onOpen: () => void;
  onMenu: (rect: DOMRect) => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(card.name);
  useEffect(() => {
    if (!renaming) return;
    setDraft(card.name);
    requestAnimationFrame(() => input.current?.select());
  }, [renaming, card.name]);

  const meta = card.missing ? 'Original photo missing' : recipeText(card.params);
  return (
    <div role="listitem" className="row project-row" onContextMenu={(e) => { e.preventDefault(); onMenu(e.currentTarget.getBoundingClientRect()); }}>
      <span className="row-body">
        <span className="project-thumb" data-missing={card.missing || undefined} aria-hidden="true">
          {card.thumb && !card.missing ? <img src={card.thumb} alt="" draggable={false} /> : card.missing ? <Icon name="warning" size={14} /> : null}
        </span>
        {renaming ? (
          <form
            className="row-text"
            onSubmit={(e) => { e.preventDefault(); onRename(draft); }}
          >
            <input
              ref={input}
              className="project-rename"
              aria-label="Project name"
              value={draft}
              maxLength={120}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => onRename(draft)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancelRename(); } }}
            />
            <span className="t-subhead secondary">{meta}</span>
          </form>
        ) : (
          <button type="button" className="row-text project-open" onClick={onOpen}>
            <span className="t-body" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.name}</span>
            <span className="t-subhead secondary" style={{ color: card.missing ? 'var(--orange)' : undefined }}>{meta}</span>
          </button>
        )}
        <span className="t-footnote tertiary tabular" style={{ whiteSpace: 'nowrap' }} title={relativeTime(card.updatedAt)}>{shortTime(card.updatedAt)}</span>
        <PressButton className="icon-btn plain" aria-label={`More for ${card.name}`} onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}>
          <Icon name="more" size={18} />
        </PressButton>
      </span>
    </div>
  );
}
