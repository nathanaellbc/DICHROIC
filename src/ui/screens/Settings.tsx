/**
 * Settings (dari dock Welcome back): tampilan, rasa (haptic), model lens blur
 * dan Refine Edge (unduh lebih dulu, hapus, model bawaan), penyimpanan
 * (hapus proyek, hapus model, Clear App Data), dan tentang. Daftar
 * berkelompok yang sama dengan bagian lain app; aksi yang menghapus data
 * selalu lewat konfirmasi.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { ActionSheet, Spinner } from '../components/Overlays';
import { PressButton, Segmented, Switch } from '../components/controls';
import { engine } from '../engine/engine';
import { useEngineState, useProjects } from '../hooks';
import { haptic, hapticsEnabled, setHapticsEnabled } from '../haptics';
import { projects } from '../projects/projects';
import { useTheme, THEME_LABEL } from '../theme';
import type { ThemePref } from '../theme';
import { DICHROIC_VERSION } from '../../version';
import { DEPTH_MODELS } from '../../depth/model';
import type { DepthModelId } from '../../depth/model';
import { clearAppData, clearModels, downloadAsset, formatBytes, missingBytes, modelAssets, removeAsset, storageUsage } from '../settings/assets';
import type { ModelAsset } from '../settings/assets';

type Confirm = { message: string; action: string; run: () => Promise<void> | void };

function Section({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="list-section">
      <h3 className="list-header">{title}</h3>
      <div className="list">{children}</div>
      {footer && <p className="list-footer t-footnote">{footer}</p>}
    </section>
  );
}

/** Baris statis: label (+ keterangan) di kiri, kontrol/nilai di kanan. */
function Row({ label, detail, children }: { label: string; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="row-static">
      <span className="row-body">
        <span className="row-text">
          <span className="t-body">{label}</span>
          {detail && <span className="t-footnote secondary">{detail}</span>}
        </span>
        {children}
      </span>
    </div>
  );
}

/** Baris aksi (tombol satu baris; merah untuk yang menghapus). */
function ActionRow({ label, detail, destructive, onPress, disabled }: { label: string; detail?: string; destructive?: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="row" disabled={disabled} onClick={onPress}>
      <span className="row-body">
        <span className="row-text">
          <span className="t-body" style={{ color: destructive ? 'var(--red-text)' : 'var(--blue-text)' }}>{label}</span>
          {detail && <span className="t-footnote secondary">{detail}</span>}
        </span>
      </span>
    </button>
  );
}

type ModelStatus = { missing: number } | { progress: number } | { error: string };

function ModelRow({ asset, status, onDownload, onRemove }: { asset: ModelAsset; status: ModelStatus | undefined; onDownload: () => void; onRemove: () => void }) {
  const size = formatBytes(asset.files.reduce((n, f) => n + f.bytes, 0));
  let right: ReactNode = <Spinner size={16} />;
  let detail = `${asset.name} · ${size}`;
  if (status && 'progress' in status) {
    right = <span className="t-footnote secondary tabular">{Math.round(status.progress * 100)}%</span>;
    detail = `Downloading ${asset.name}…`;
  } else if (status && 'error' in status) {
    detail = status.error;
    right = <PressButton className="capsule bordered settings-chip" onClick={onDownload}>Retry</PressButton>;
  } else if (status && status.missing === 0) {
    right = (
      <span className="settings-ready">
        <span className="t-footnote secondary">On device</span>
        <PressButton className="icon-btn plain settings-remove" aria-label={`Remove ${asset.label} model`} onClick={onRemove}>
          <Icon name="trash" size={16} />
        </PressButton>
      </span>
    );
  } else if (status) {
    right = <PressButton className="capsule bordered settings-chip" onClick={onDownload}>Get · {formatBytes(status.missing)}</PressButton>;
  }
  return (
    <Row label={asset.label} detail={detail}>{right}</Row>
  );
}

export function SettingsContent({ onAfterClear }: { onAfterClear?: () => void }) {
  const [theme, setTheme] = useTheme();
  const [haptics, setHaptics] = useState(hapticsEnabled());
  const state = useEngineState();
  const proj = useProjects();
  const [assets, setAssets] = useState<ModelAsset[]>([]);
  const [status, setStatus] = useState<Record<string, ModelStatus>>({});
  const [usage, setUsage] = useState<{ usage: number; quota: number } | undefined>();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const refresh = useCallback(async (list: ModelAsset[]) => {
    const entries = await Promise.all(list.map(async (a) => [a.id, { missing: await missingBytes(a) }] as const));
    setStatus((prev) => {
      const next = { ...prev };
      // Unduhan yang sedang berjalan tetap menampilkan progresnya.
      for (const [id, s] of entries) if (!(next[id] && 'progress' in next[id]!)) next[id] = s;
      return next;
    });
    setUsage(await storageUsage());
  }, []);

  useEffect(() => {
    let live = true;
    void engine.depthRunProfile().then((run) => {
      if (!live) return;
      const list = modelAssets(run, engine.getState().depthModels);
      setAssets(list);
      void refresh(list);
    });
    return () => { live = false; };
  }, [refresh, state.depthGpu]);

  const download = async (asset: ModelAsset) => {
    setStatus((s) => ({ ...s, [asset.id]: { progress: 0 } }));
    try {
      await downloadAsset(asset, (p) => setStatus((s) => ({ ...s, [asset.id]: { progress: p } })));
      haptic();
      setStatus((s) => ({ ...s, [asset.id]: { missing: 0 } }));
    } catch (e) {
      setStatus((s) => ({ ...s, [asset.id]: { error: e instanceof Error ? e.message : 'Download failed. Check your connection.' } }));
    }
    void refresh(assets);
  };

  const ask = (c: Confirm) => setConfirm(c);
  const run = async (c: Confirm) => {
    setConfirm(null);
    await c.run();
    haptic();
    void refresh(assets);
  };

  const depthModels = state.depthModels.filter((id) => id in DEPTH_MODELS);
  const projectCount = proj.list.length;

  return (
    <div className="scroll-y settings" style={{ display: 'flex', flexDirection: 'column', gap: 22, padding: '4px 16px 40px' }}>
      <Section title="Appearance">
        <Row label="Theme" detail={theme === 'system' ? 'Follows your device' : undefined}>
          <span style={{ width: 210, flexShrink: 0 }}>
            <Segmented<ThemePref>
              label="Theme"
              small
              items={(['system', 'light', 'dark'] as const).map((v) => ({ value: v, label: THEME_LABEL[v] }))}
              value={theme}
              onChange={setTheme}
            />
          </span>
        </Row>
      </Section>

      <Section title="Feel" footer={reduceMotion ? 'Reduce Motion is on in your system settings: animations are simplified.' : 'Animations follow your system’s Reduce Motion setting.'}>
        <Row label="Haptics" detail="Ticks on rulers and taps">
          <Switch label="Haptics" checked={haptics} onChange={(on) => { setHapticsEnabled(on); setHaptics(on); if (on) haptic(); }} />
        </Row>
      </Section>

      <Section
        title="Lens Blur and Refine Edge"
        footer="Models run on this device and stay here. Download them ahead of time to use Lens Blur offline."
      >
        {depthModels.length > 1 && (
          <Row label="Depth model" detail="Used for new depth maps">
            <span style={{ width: Math.min(220, depthModels.length * 72), flexShrink: 0 }}>
              <Segmented<DepthModelId>
                label="Depth model"
                small
                items={depthModels.map((id) => ({ value: id, label: DEPTH_MODELS[id].label }))}
                value={state.depthModel}
                onChange={(id) => engine.setDepthModel(id)}
              />
            </span>
          </Row>
        )}
        {state.depthGpuOption && (
          <Row label="Measure depth on GPU" detail="Faster, uses more memory">
            <Switch label="Measure depth on GPU" checked={state.depthGpu} onChange={(on) => engine.setDepthGpu(on)} />
          </Row>
        )}
        {assets.length === 0 && <Row label="Checking models…"><Spinner size={16} /></Row>}
        {assets.map((asset) => (
          <ModelRow
            key={asset.id}
            asset={asset}
            status={status[asset.id]}
            onDownload={() => void download(asset)}
            onRemove={() => ask({ message: `Remove ${asset.label} (${asset.name}) from this device? You can download it again later.`, action: 'Remove Model', run: () => removeAsset(asset) })}
          />
        ))}
      </Section>

      <Section
        title="Storage"
        footer={usage ? `gammā uses ${formatBytes(usage.usage)} on this device.` : undefined}
      >
        <ActionRow
          label="Delete All Projects"
          detail={projectCount ? `${projectCount} ${projectCount === 1 ? 'project' : 'projects'} with their photos` : 'No projects yet'}
          destructive
          disabled={projectCount === 0}
          onPress={() => ask({ message: `Delete all ${projectCount} projects and their photos from this device? This can’t be undone.`, action: 'Delete All Projects', run: () => projects.removeAll() })}
        />
        <ActionRow
          label="Remove Downloaded Models"
          detail="Depth and Refine Edge models"
          destructive
          onPress={() => ask({ message: 'Remove all downloaded models? Lens Blur will download them again when you use it.', action: 'Remove Models', run: clearModels })}
        />
        <ActionRow
          label="Clear App Data"
          detail="Projects, models, settings and the offline copy"
          destructive
          onPress={() => ask({
            message: 'Erase everything gammā keeps on this device — projects, photos, models and settings — and restart? This can’t be undone.',
            action: 'Clear App Data',
            run: async () => { onAfterClear?.(); await clearAppData(() => projects.removeAll()); },
          })}
        />
      </Section>

      <Section title="About">
        <Row label="Version"><span className="t-body secondary tabular">{DICHROIC_VERSION}</span></Row>
        <Row label="Privacy" detail="Photos are developed on this device and never uploaded." />
      </Section>

      <ActionSheet
        open={confirm !== null}
        anchor={null}
        message={confirm?.message}
        actions={confirm ? [{ label: confirm.action, destructive: true, onSelect: () => void run(confirm) }] : []}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
