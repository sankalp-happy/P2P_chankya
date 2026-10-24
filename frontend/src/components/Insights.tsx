import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import { useDeferredValue, useMemo, useState } from 'react';
import { useDataset, useForecasts, useRecommend } from '../api/hooks';
import type { Recommendation } from '../api/types';
import { deriveAlerts, type Alert } from '../lib/alerts';
import { BUILDING_SPRITE, SHORT_NAME } from '../lib/constants';
import { fmtInt, fmtNum, fmtRs } from '../lib/format';
import { useTime } from '../store/time';
import { Empty, Panel, Skeleton, Sprite } from './ui';

export function ActionsPanel({ t: liveT, buildingFilter, className }: { t: number; buildingFilter?: string; className?: string }) {
  // Low priority while playing: React may skip/interrupt this render so clicks stay instant.
  const t = useDeferredValue(liveT);
  const { data, isLoading } = useRecommend(t, buildingFilter ? 12 : 5);
  const items = (data ?? []).filter((r) => !buildingFilter || r.building_id === buildingFilter).slice(0, 5);
  const [open, setOpen] = useState<string | null>(null);
  const total = items.reduce((s, r) => s + r.rupees_saved, 0);

  return (
    <Panel
      className={className}
      title="Top actions"
      right={
        items.length > 0 && (
          <span className="mono text-[11px] text-dim">
            up to <span className="text-fg">{fmtRs(total)}</span>/wk
          </span>
        )
      }
    >
      {isLoading && !data ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Empty title="Nothing to fix right now" detail="Every building is tracking its ghost. Check back as the week moves." />
      ) : (
        <ol className="space-y-2">
          <AnimatePresence initial={false}>
            {items.map((r, i) => (
              <ActionItem key={`${r.building_id}${r.cause}`} r={r} index={i} open={open === `${r.building_id}${r.cause}`} onToggle={setOpen} />
            ))}
          </AnimatePresence>
        </ol>
      )}
    </Panel>
  );
}

function ActionItem({ r, index, open, onToggle }: { r: Recommendation; index: number; open: boolean; onToggle: (k: string | null) => void }) {
  const key = `${r.building_id}${r.cause}`;
  return (
    <motion.li layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ delay: index * 0.03, duration: 0.2 }}>
      <button
        onClick={() => {
          onToggle(open ? null : key);
          const s = useTime.getState();
          s.setBuilding(r.building_id);
          if (r.stream) s.setStream(r.stream);
        }}
        aria-expanded={open}
        className={clsx(
          'pixel w-full p-3 text-left [--px:4px]',
          open ? '[--pb:var(--color-ghost)] [--pf:var(--color-raised)]' : '[--pf:var(--color-bg)] hover:[--pb:var(--color-line-strong)]',
        )}
      >
        <div className="flex items-start gap-3">
          <span className="num w-5 pt-0.5 text-[20px] text-faint">{index + 1}</span>
          <Sprite name={BUILDING_SPRITE[r.building_id]} size={30} />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] leading-snug font-medium text-fg">{r.cause}</div>
            <div className="mono mt-1 text-[10.5px] tracking-[0.08em] text-dim uppercase">
              {SHORT_NAME[r.building_id]}
              {r.stream ? ` · ${r.stream}` : ''}
            </div>
          </div>
          <div className="text-right">
            <div className="num text-[18px]">{r.rupees_saved > 0 ? fmtRs(r.rupees_saved) : '—'}</div>
            <div className="mono text-[10px] text-dim">{r.co2_kg > 0 ? `${fmtNum(r.co2_kg, 1)} kg CO₂` : 'per week'}</div>
          </div>
        </div>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="mt-3 space-y-2.5 border-t border-line pt-3 pl-8">
                <div>
                  <div className="eyebrow mb-1 text-[10px]">Do this</div>
                  <p className="text-[13px] text-fg">{r.action}</p>
                </div>
                <div>
                  <div className="eyebrow mb-1 text-[10px]">Why</div>
                  <p className="text-[12.5px] leading-relaxed text-soft">{r.why}</p>
                </div>
                {r.evidence && (
                  <div className="flex flex-wrap gap-1.5">
                    {r.evidence.map((e) => (
                      <span key={e} className="chip h-[22px] text-[9.5px]">
                        {e}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </button>
    </motion.li>
  );
}

export function useAlerts(t: number) {
  const { data: ix } = useDataset();
  const ids = ix?.ids ?? [];
  const fe = useForecasts(ids, 'electricity', t);
  const fw = useForecasts(ids, 'water', t);
  const feData = fe.map((q) => q.data);
  const fwData = fw.map((q) => q.data);
  return useMemo(() => {
    if (!ix) return [];
    const toMap = (arr: typeof feData) => Object.fromEntries(ids.map((id, i) => [id, arr[i]]));
    return deriveAlerts(ix, t, { electricity: toMap(feData), water: toMap(fwData) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ix, t, ...feData, ...fwData]);
}

const KIND_LABEL: Record<Alert['kind'], string> = { spike: 'Spike ahead', offline: 'Offline', mismatch: 'Log ≠ sensor' };

export function AlertsPanel({ t: liveT, buildingFilter, className, max = 7 }: { t: number; buildingFilter?: string; className?: string; max?: number }) {
  const t = useDeferredValue(liveT);
  const all = useAlerts(t);
  const alerts = all.filter((a) => !buildingFilter || a.building_id === buildingFilter).slice(0, max);
  const counts = all.reduce<Record<string, number>>((m, a) => ((m[a.kind] = (m[a.kind] ?? 0) + 1), m), {});

  return (
    <Panel
      className={className}
      title={
        <span className="eyebrow inline-flex items-center gap-2">
          <span className={clsx('size-1.5', all.length ? 'animate-pulse-dot bg-alert' : 'bg-faint')} />
          Alerts
        </span>
      }
      right={
        <div className="flex gap-1.5">
          {(['spike', 'offline', 'mismatch'] as const).map((k) => (
            <span key={k} className={clsx('chip h-[22px]', counts[k] ? 'text-fg' : 'text-faint')}>
              {counts[k] ?? 0} {k}
            </span>
          ))}
        </div>
      }
    >
      {alerts.length === 0 ? (
        <Empty sprite="ghast" title="All quiet" detail="No spikes forecast, every gateway online, logs agree with sensors." />
      ) : (
        <ul className="space-y-1.5">
          <AnimatePresence initial={false}>
            {alerts.map((a) => (
              <motion.li
                key={a.id}
                layout
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.22 }}
                className="pixel flex items-start gap-3 p-3 [--px:4px] [--pf:var(--color-bg)]"
              >
                <div className={clsx(a.kind === 'spike' && 'animate-shake')}>
                  <Sprite name={a.kind === 'offline' ? BUILDING_SPRITE[a.building_id] : 'creeper'} size={30} grey={a.kind === 'offline'} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={clsx('mono text-[9.5px] tracking-[0.12em] uppercase', a.kind === 'mismatch' ? 'text-soft' : 'text-alert')}>{KIND_LABEL[a.kind]}</span>
                    <span className="mono text-[10px] text-faint">{when(a.at, t)}</span>
                  </div>
                  <div className="mt-0.5 text-[13px] font-medium text-fg">{a.title}</div>
                  <div className="mt-0.5 text-[12px] leading-snug text-dim">{a.detail}</div>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Panel>
  );
}

function when(at: number, now: number) {
  const d = at - now;
  if (d > 0) return `in ${d} h`;
  if (d === 0) return 'now';
  return -d < 48 ? `${-d} h ago` : `${fmtInt(-d / 24)} d ago`;
}
