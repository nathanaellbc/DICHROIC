/**
 * Wadah buka foto di area foto editor, kartu "sedang membuka", dan layar bila
 * WebGPU tidak tersedia. Aplikasi langsung membuka editor; selama belum ada
 * foto, area fotonya berisi `DropZone`.
 */
import { AnimatePresence, motion, useMotionValue, useReducedMotion } from 'motion/react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChromeWordmark, GlassOrb } from '../components/WelcomeIntro';
import { releaseBoot } from '../boot';
import { StickerBurst } from '../components/StickerField';
import { StarField } from '../components/StarField';
import { IntroBackdrop } from '../components/IntroBackdrop';
import { RingBloom } from '../components/RingBloom';
import type { IntroPhase, StageBox } from '../components/WelcomeIntro';
import { Icon } from '../components/Icon';
import { ActionSheet, Spinner } from '../components/Overlays';
import { RecentStrip } from '../components/RecentStrip';
import { Sheet } from '../components/Sheet';
import { PressButton } from '../components/controls';
import { HAS_PROJECTS_KEY, projects } from '../projects/projects';
import type { ProjectCard } from '../projects/projects';
import { ProjectsContent } from './Projects';
import { dayGroup } from '../projects/format';
import { overlay, pressRelease, pressScale, scrimMotion } from '../motion';
import { useEffect } from 'react';
import { activateModal } from '../modalFocus';
import { useDialogKeys, useProjects } from '../hooks';

/**
 * Area foto kosong di editor (belum ada foto): wadah seret-lepas yang juga
 * membuka pemilih berkas bila diketuk. Lepasnya ditangani pendengar `drop`
 * di jendela (App); di sini hanya sorotan saat berkas diseret di atasnya.
 */
export function DropZone({ onChoose: choose, engineReady, engineFailed, enginePaused }: { onChoose: () => void; engineReady: boolean; engineFailed?: boolean; enginePaused?: boolean }) {
  const [over, setOver] = useState(false);
  const proj = useProjects();
  // Pemilih berkas biasa: bukan memilih ulang foto proyek.
  const onChoose = useCallback(() => {
    projects.requestRelink(undefined);
    choose();
  }, [choose]);
  const [menu, setMenu] = useState<{ card: ProjectCard; anchor: DOMRect } | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | undefined>();
  const relink = (card: ProjectCard) => {
    projects.requestRelink(card.id);
    choose();
  };
  const openProject = (card: ProjectCard) => {
    setAllOpen(false);
    // Pemilih berkas harus dibuka langsung dari ketukan (Safari iOS), bukan setelah await.
    if (card.missing) { relink(card); return; }
    // Berkas ternyata hilang: kartunya berubah menjadi "Original photo missing".
    void projects.open(card.id);
  };
  const touch = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches, []);
  const reduce = !!useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  /** Salinan latar untuk kaca WebGL (lihat IntroBackdrop). */
  const backdrop = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<StageBox>({ width: 0, height: 0 });
  // Intro sekali per sesi; Reduce Motion langsung ke isi.
  // Ada proyek tersimpan: langsung ke Recent, tanpa intro (penanda dibaca sinkron).
  const [phase, setPhase] = useState<IntroPhase>(() => (reduce || storage('session')?.getItem(WELCOMED_KEY) || hasProjects() ? 'ready' : 'splash'));
  // Tanpa intro (sudah disambut, Reduce Motion): layar boot langsung memudar.
  // Dengan intro, ChromeWordmark menerbangkan logonya ke wordmark.
  useLayoutEffect(() => {
    if (phase === 'ready') void releaseBoot();
    // Hanya keadaan awal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return undefined;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Kubah -> "+": sepenuhnya mengikuti gesture pengguna (GlassOrb), tanpa timer;
  // selesai = fase ready.
  const progress = useMotionValue(phase === 'ready' ? 1 : 0);
  const commit = useCallback(() => {
    storage('session')?.setItem(WELCOMED_KEY, '1');
    setPhase('ready');
  }, []);

  // Proyek baru selesai dimuat saat intro masih tampil (penanda belum ada): lewati intro.
  useEffect(() => {
    if (phase !== 'splash' || !proj.loaded || proj.list.length === 0) return;
    progress.set(1);
    commit();
    void releaseBoot();
  }, [phase, proj.loaded, proj.list.length, progress, commit]);

  // Berkas bisa dijatuhkan di mana saja di jendela (pendengar `drop` di App);
  // sorotan menyala selama berkas diseret di atas jendela mana pun.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enterDrag = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setOver(true);
      setPhase('ready');
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const reset = () => {
      depth = 0;
      setOver(false);
    };
    window.addEventListener('dragenter', enterDrag);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', reset);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', enterDrag);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', reset);
      window.removeEventListener('dragend', reset);
    };
  }, []);

  // Baris terakhir judul berganti pelan (seperti referensi).
  const [line, setLine] = useState(0);
  useEffect(() => {
    if (phase !== 'ready' || reduce || over) return undefined;
    const id = window.setInterval(() => setLine((n) => (n + 1) % TAIL_LINES.length), 3200);
    return () => window.clearInterval(id);
  }, [phase, reduce, over]);

  // Status darkroom hanya sebagai teks kecil; tanpa titik berdenyut.
  const status = engineFailed ? 'Darkroom stopped. Choose a photo to retry.'
    : enginePaused ? 'Darkroom resting until you choose a photo.'
      : engineReady ? null : 'Preparing the darkroom…';
  const ready = phase === 'ready';
  // Narrow or short stages: fewer, smaller stickers.
  const compact = box.width < 560 || box.height < 600;
  const orbCenter = { x: box.width / 2, y: box.height * 0.42 };
  // Ada proyek: Recent menggantikan stiker dan tombol "+" (intro tetap untuk pengguna baru).
  const recent = proj.list.slice(0, compact ? 5 : 7);
  const showRecent = ready && !over && recent.length > 0;
  const regular = typeof document !== 'undefined' && document.documentElement.dataset.size === 'regular';
  const ctaPress = { whileTap: { scale: pressScale }, transition: pressRelease };
  // All Projects setinggi isinya (bar, cari, judul grup, baris, catatan); banyak proyek = penuh.
  const allGroups = new Set(proj.list.map((c) => dayGroup(c.updatedAt))).size;
  const allFraction = typeof window === 'undefined' ? 0.9
    : Math.min(0.9, Math.max(0.36, (170 + allGroups * 46 + proj.list.length * 61) / window.innerHeight));

  return (
    <div ref={stage} className="empty-photo start-stage intro-stage" data-drag-over={over} data-phase={phase}>
      <IntroBackdrop canvasRef={backdrop} />
      <div className="intro-sky" aria-hidden="true"><StarField /></div>
      <div className="start-dropframe" aria-hidden="true" />
      <ChromeWordmark visible={phase === 'splash'} progress={progress} />
      <StickerBurst show={ready && !over && !showRecent} origin={orbCenter} orbRadius={32} box={box} compact={compact} reduce={reduce} />
      {box.width > 0 && (
        <div className="intro-orb-slot" data-hidden={showRecent || undefined} aria-hidden={showRecent || undefined}>
          <GlassOrb phase={phase} progress={progress} box={box} onCommit={commit} onChoose={onChoose} reduce={reduce} backdrop={backdrop} hint={touch ? 'Swipe up to continue' : 'Scroll or drag up to continue'} />
        </div>
      )}
      {/* Glow cincin kaca: ikut bola "+", jadi tidak tampil di atas Recent. */}
      {box.width > 0 && !showRecent && <RingBloom backdrop={backdrop} />}

      {ready && (
        <motion.div
          className="photo-dropzone intro-content"
          data-recent={showRecent || undefined}
          style={{ paddingTop: showRecent ? (regular ? 32 : 'calc(max(var(--safe-top, 0px), 12px) + 8px)') : orbCenter.y + (compact ? 48 : 56) }}
          data-drag-over={over}
          initial="hidden"
          animate="shown"
          variants={{ shown: { transition: { staggerChildren: 0.09, delayChildren: reduce ? 0 : 0.1 } } }}
        >
          {showRecent ? (
            <>
              <motion.div className="welcome-bar" variants={rise}>
                <span className="welcome-word">gammā</span>
                {proj.list.length > 1 && (
                  <motion.button type="button" className="welcome-chip" onClick={() => setAllOpen(true)} {...ctaPress}>
                    All · {proj.list.length}
                  </motion.button>
                )}
              </motion.div>
              <motion.h1 className="welcome-title" variants={rise}>
                Welcome back.
                <span>Pick up a roll.</span>
              </motion.h1>
            </>
          ) : over ? (
            <h1 className="start-title intro-title" key="drop">
              <BlurWords text="Drop to develop." />
              <span className="start-title-tail"><BlurWords text="Let go anywhere." delay={0.12} /></span>
            </h1>
          ) : (
            <h1 className="start-title intro-title" key="title" aria-label={`Develop your photo ${TAIL_LINES[line]}`}>
              <span aria-hidden="true">
                <BlurWords text="Develop your" /> <s className="intro-strike">filter</s> <BlurWords text="photo" delay={0.2} />
              </span>
              <span className="start-title-tail" aria-hidden="true"><BlurWords key={line} text={TAIL_LINES[line]!} delay={line === 0 ? 0.3 : 0} /></span>
            </h1>
          )}
          {showRecent && (
            <motion.div className="recent-slot" variants={rise}>
              <RecentStrip
                cards={recent}
                onOpen={openProject}
                onRelink={relink}
                onMenu={(card, anchor) => setMenu({ card, anchor })}
              />
            </motion.div>
          )}
          <motion.div className="start-actions intro-actions" variants={rise}>
            <motion.button type="button" className="start-cta intro-cta" data-secondary={showRecent || undefined} onClick={onChoose} {...ctaPress}>
              {showRecent ? 'New Photo' : 'Choose Photo'}
            </motion.button>
            <p className="start-footnote intro-footnote">
              {touch ? 'RAW, JPEG, PNG, TIFF and OpenEXR.' : 'Or drop a file anywhere. RAW, JPEG, PNG, TIFF and OpenEXR.'} Nothing is uploaded.
              {status && <span className="start-status" role="status" aria-live="polite">{status}</span>}
            </p>
          </motion.div>
        </motion.div>
      )}

      <ActionSheet
        open={menu !== null}
        anchor={menu?.anchor ?? null}
        label={menu ? `${menu.card.name} options` : 'Project options'}
        actions={menu ? [
          { label: menu.card.missing ? 'Choose Photo Again…' : 'Open', icon: menu.card.missing ? 'warning' : 'open', onSelect: () => { const c = menu.card; setMenu(null); if (c.missing) relink(c); else openProject(c); } },
          { label: 'Rename', icon: 'rename', onSelect: () => { const c = menu.card; setMenu(null); setRenaming(c.id); setAllOpen(true); } },
          { label: 'Duplicate', icon: 'duplicate', onSelect: () => { const c = menu.card; setMenu(null); void projects.duplicate(c.id); } },
          { label: 'Delete', icon: 'trash', destructive: true, onSelect: () => { const c = menu.card; setMenu(null); projects.remove(c.id); } },
        ] : []}
        onCancel={() => setMenu(null)}
      />

      <Sheet
        open={allOpen}
        centered={regular}
        title="All Projects"
        detents={allFraction < 0.9 ? ['medium', 'large'] : ['large']}
        mediumFraction={allFraction}
        dimAtMedium
        onClose={() => { setAllOpen(false); setRenaming(undefined); }}
        trailing={
          <PressButton className="icon-btn" aria-label="Done" onClick={() => { setAllOpen(false); setRenaming(undefined); }}>
            <Icon name="check" size={18} strokeWidth={2.8} />
          </PressButton>
        }
      >
        <ProjectsContent
          cards={proj.list}
          renaming={renaming}
          onOpen={openProject}
          onRelink={(c) => { setAllOpen(false); relink(c); }}
          onMenu={(card, anchor) => setMenu({ card, anchor })}
          onRename={(card, name) => { setRenaming(undefined); void projects.rename(card.id, name); }}
          onCancelRename={() => setRenaming(undefined)}
          usage={`${proj.list.length} ${proj.list.length === 1 ? 'project' : 'projects'} · saved on this device`}
        />
      </Sheet>
    </div>
  );
}

const WELCOMED_KEY = 'dichroic.welcomed';

function hasProjects(): boolean {
  try { return window.localStorage.getItem(HAS_PROJECTS_KEY) === '1'; } catch { return false; }
}
/** Baris kedua judul: film sungguhan, bukan filter. */
const TAIL_LINES = ['on real film.', 'on Kodak Portra 400.', 'printed on Kodak 2383.', 'right on this device.'];

function storage(kind: 'session'): Storage | undefined {
  try { return kind === 'session' ? window.sessionStorage : undefined; } catch { return undefined; }
}

/** Kata per kata muncul dari blur halus (Blur Text React Bits, versi singkat). */
function BlurWords({ text, delay = 0 }: { text: string; delay?: number }) {
  return (
    <>
      {text.split(' ').map((word, i) => [
        i > 0 ? ' ' : null,
        <motion.span
          key={`${word}-${i}`}
          className="start-word"
          initial={{ opacity: 0, filter: 'blur(8px)', y: 8 }}
          animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
          transition={{ duration: 0.7, delay: delay + i * 0.06, ease: [0.22, 1, 0.36, 1] }}
        >
          {word}
        </motion.span>,
      ])}
    </>
  );
}

const rise = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

export function OpeningCard({ opening, onCancel }: { opening?: { name: string; stage: string }; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const open = opening !== undefined;
  useDialogKeys(ref, onCancel, false, open);
  useEffect(() => { if (open && ref.current) return activateModal(ref.current); }, [open]);
  return (
    <AnimatePresence>
      {opening && (
        <>
          <motion.div className="alert-scrim" {...scrimMotion()} aria-hidden="true" />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label="Opening photo"
            aria-live="polite"
            className="alert"
            style={{ x: '-50%', y: '-50%', width: 270, alignItems: 'center', padding: '24px var(--inset-alert) var(--inset-alert)', gap: 14 }}
            initial={{ opacity: 0, scale: 1.1 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
            transition={overlay()}
            onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
          >
            <span style={{ color: 'var(--blue)' }}><Spinner size={36} /></span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="t-headline" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 230 }}>Opening {opening.name}</span>
              <span className="t-subhead secondary">{opening.stage}</span>
            </div>
            <button type="button" className="capsule" style={{ width: '100%' }} onClick={onCancel}>Cancel</button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export function UnsupportedScreen() {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box', textAlign: 'center' }}>
      <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
        <span style={{ color: 'var(--orange)' }}><Icon name="warning" size={40} strokeWidth={1.8} /></span>
        <h1 className="t-title2" style={{ margin: 0 }}>WebGPU Isn’t Available</h1>
        <p className="t-body secondary" style={{ margin: 0 }}>
          gammā develops every photo on your GPU. Open it in Safari on iOS 26 or later, or in a current version of Chrome, Edge or Firefox.
        </p>
      </div>
    </div>
  );
}
