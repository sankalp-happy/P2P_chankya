import clsx from 'clsx';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { useDataset } from '../api/hooks';
import { PageHeader } from '../components/PageHeader';
import CountUp from '../components/rb/CountUp';
import { Panel, Skeleton, Sprite } from '../components/ui';
import { BUILDING_SPRITE, COMPOST_RATIO, SHORT_NAME } from '../lib/constants';
import type { DataIndex } from '../lib/dataset';
import { fmtNum } from '../lib/format';
import { dayIndex, fmtDay } from '../lib/time';
import { useTime } from '../store/time';

type Period = 1 | 7;
type SortKey = 'diversion' | 'landfill' | 'contamination';

interface Agg {
  id: string;
  wet: number;
  dry: number;
  composted: number;
  recycled: number;
  landfill: number;
  contamination: number;
  diversion: number;
  hasComposter: boolean;
}

function aggregate(ix: DataIndex, lastDay: number, days: Period): Agg[] {
  return ix.ids.map((id) => {
    const a = { wet: 0, dry: 0, composted: 0, recycled: 0, landfill: 0, cont: 0, n: 0 };
    for (let d = Math.max(0, lastDay - days + 1); d <= lastDay; d++) {
      const row = ix.dailyBy.get(`${id}|${ix.calByDay[d]?.date}`);
      if (!row) continue;
      a.wet += row.wet_organic_kg ?? 0;
      a.dry += row.dry_recyclable_kg ?? 0;
      a.composted += row.composted_kg ?? 0;
      a.recycled += row.recycled_kg ?? 0;
      a.landfill += row.landfill_kg ?? 0;
      if (row.contamination_pct != null) {
        a.cont += row.contamination_pct;
        a.n++;
      }
    }
    const out = a.composted + a.recycled + a.landfill;
    return {
      id,
      wet: a.wet,
      dry: a.dry,
      composted: a.composted,
      recycled: a.recycled,
      landfill: a.landfill,
      contamination: a.n ? a.cont / a.n : NaN,
      diversion: out ? ((a.composted + a.recycled) / out) * 100 : NaN,
      hasComposter: !!ix.byId.get(id)?.has_composter,
    };
  });
}

export default function Waste() {
  const t = useTime((s) => s.t);
  const { data: ix } = useDataset();
  const [period, setPeriod] = useState<Period>(7);
  const [sort, setSort] = useState<SortKey>('diversion');
  const day = dayIndex(t);

  const rows = useMemo(() => (ix ? aggregate(ix, day, period) : []), [ix, day, period]);
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) =>
        sort === 'diversion' ? b.diversion - a.diversion : sort === 'landfill' ? b.landfill - a.landfill : b.contamination - a.contamination,
      ),
    [rows, sort],
  );

  if (!ix) return <Skeleton className="h-[70vh]" />;

  const tot = rows.reduce(
    (s, r) => ({ composted: s.composted + r.composted, recycled: s.recycled + r.recycled, landfill: s.landfill + r.landfill }),
    { composted: 0, recycled: 0, landfill: 0 },
  );
  const all = tot.composted + tot.recycled + tot.landfill || 1;
  const contam = rows.filter((r) => Number.isFinite(r.contamination));
  const avgContam = contam.reduce((s, r) => s + r.contamination, 0) / (contam.length || 1);
  const maxOut = Math.max(1, ...rows.map((r) => r.composted + r.recycled + r.landfill));
  const from = ix.calByDay[Math.max(0, day - period + 1)]?.date;
  const to = ix.calByDay[day]?.date;

  return (
    <>
      <PageHeader
        index={6}
        title="Waste & recycling"
        sub="Where every building's waste ends up: wet waste to on-site composters, dry waste to certified recyclers, and whatever is left to landfill."
        right={
          <div className="flex items-center gap-3">
            <div className="seg">
              <button data-on={period === 1} onClick={() => setPeriod(1)}>
                Today
              </button>
              <button data-on={period === 7} onClick={() => setPeriod(7)}>
                Last 7 days
              </button>
            </div>
            <span className="mono text-[11px] text-dim">
              {from && to ? (period === 1 ? fmtDay(to) : `${fmtDay(from)} – ${fmtDay(to)}`) : ''}
            </span>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Composted" value={tot.composted} unit="kg" sub={`→ ${fmtNum(tot.composted / COMPOST_RATIO, 0)} kg of compost`} sprite="composter" />
        <Kpi label="Recycled" value={tot.recycled} unit="kg" sub="to certified off-takers" sprite="recycle_chest" />
        <Kpi label="Landfill" value={tot.landfill} unit="kg" sub="residual, not diverted" sprite="landfill" tone="alert" />
        <Kpi label="Kept out of landfill" value={((tot.composted + tot.recycled) / all) * 100} unit="%" sub="diversion rate" decimals={1} tone="ghost" />
        <Kpi label="Recycling contamination" value={avgContam} unit="%" sub="avg across buildings" decimals={1} />
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4">
        <Panel
          className="col-span-12 xl:col-span-8"
          title="By building"
          right={
            <div className="flex items-center gap-3">
              <span className="eyebrow">Sort</span>
              <div className="seg">
                {(['diversion', 'landfill', 'contamination'] as SortKey[]).map((k) => (
                  <button key={k} data-on={sort === k} onClick={() => setSort(k)}>
                    {k}
                  </button>
                ))}
              </div>
            </div>
          }
        >
          <div className="mono mb-2 flex items-center gap-4 text-[10px] tracking-[0.08em] text-dim uppercase">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 bg-good" /> Composted
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 bg-soft" /> Recycled
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 bg-alert/70" /> Landfill
            </span>
          </div>
          <ul className="space-y-1.5">
            {sorted.map((r) => (
              <motion.li
                key={r.id}
                layout
                transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                className="pixel grid grid-cols-[minmax(150px,1fr)_minmax(260px,2.4fr)_80px_96px] items-center gap-4 px-3 py-2.5 [--pf:var(--color-bg)] [--px:4px]"
              >
                <div className="flex items-center gap-2.5">
                  <Sprite name={BUILDING_SPRITE[r.id]} size={30} />
                  <div>
                    <div className="text-[13.5px] font-medium">{SHORT_NAME[r.id]}</div>
                    <div className="mono text-[9.5px] text-faint">{r.hasComposter ? 'composter on site' : 'no composter'}</div>
                  </div>
                </div>
                <div>
                  <div className="flex h-3 gap-px" style={{ width: `${((r.composted + r.recycled + r.landfill) / maxOut) * 100}%` }}>
                    <Seg v={r.composted} cls="bg-good" total={r.composted + r.recycled + r.landfill} />
                    <Seg v={r.recycled} cls="bg-soft" total={r.composted + r.recycled + r.landfill} />
                    <Seg v={r.landfill} cls="bg-alert/70" total={r.composted + r.recycled + r.landfill} />
                  </div>
                  <div className="mono mt-1.5 flex gap-4 text-[10.5px] text-dim">
                    <span>{fmtNum(r.composted, 0)} kg compost in</span>
                    <span>{fmtNum(r.recycled, 0)} kg recycled</span>
                    <span className="text-alert/90">{fmtNum(r.landfill, 0)} kg landfill</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className={clsx('num text-[20px]', r.diversion >= 60 ? 'text-good' : 'text-fg')}>{fmtNum(r.diversion, 0)}%</div>
                  <div className="mono text-[9px] text-faint uppercase">diverted</div>
                </div>
                <div className="text-right">
                  <div className={clsx('mono text-[13px]', r.contamination > 15 ? 'text-alert' : 'text-soft')}>{fmtNum(r.contamination, 1)}%</div>
                  <div className="mono text-[9px] text-faint uppercase">contamination</div>
                </div>
              </motion.li>
            ))}
          </ul>
        </Panel>

        <Panel className="col-span-12 xl:col-span-4" title="Where it ends up · campus">
          <div className="space-y-3">
            <Dest sprite="composter" label="Composters" kg={tot.composted} share={tot.composted / all} note={`makes ${fmtNum(tot.composted / COMPOST_RATIO, 0)} kg of compost (4:1)`} tone="ghost" />
            <Dest sprite="recycle_chest" label="Recyclers" kg={tot.recycled} share={tot.recycled / all} note="paper, plastic, glass, metal, e-waste" />
            <Dest sprite="landfill" label="Landfill" kg={tot.landfill} share={tot.landfill / all} note="the number we're trying to shrink" tone="alert" />
          </div>
          <p className="mt-4 text-[12px] leading-relaxed text-dim">
            Buildings without a composter can't divert wet waste on site. Routing their food waste to the nearest composter is the single biggest landfill cut on campus.
          </p>
        </Panel>
      </div>
    </>
  );
}

function Seg({ v, total, cls }: { v: number; total: number; cls: string }) {
  if (!v || !total) return null;
  return <div className={clsx('h-full transition-[width] duration-300', cls)} style={{ width: `${(v / total) * 100}%` }} />;
}

function Kpi({ label, value, unit, sub, sprite, decimals = 0, tone }: { label: string; value: number; unit: string; sub: string; sprite?: string; decimals?: number; tone?: 'ghost' | 'alert' }) {
  return (
    <div className="panel px-5 py-4">
      <div className="flex items-start justify-between">
        <div className="eyebrow">{label}</div>
        {sprite && <Sprite name={sprite} size={28} />}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <CountUp to={Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0} decimals={decimals} duration={0.45} separator="," trigger="load" className={clsx('num text-[34px]', tone === 'ghost' && 'text-good', tone === 'alert' && 'text-alert')} />
        <span className="mono text-[11px] text-dim">{unit}</span>
      </div>
      <div className="mono mt-2 text-[10px] text-faint">{sub}</div>
    </div>
  );
}

function Dest({ sprite, label, kg, share, note, tone }: { sprite: string; label: string; kg: number; share: number; note: string; tone?: 'ghost' | 'alert' }) {
  return (
    <div className="pixel flex items-center gap-4 p-3 [--pf:var(--color-bg)] [--px:4px]">
      <Sprite name={sprite} size={48} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between">
          <span className="text-[14px] font-medium">{label}</span>
          <span className={clsx('num text-[20px]', tone === 'ghost' && 'text-good', tone === 'alert' && 'text-alert')}>{fmtNum(share * 100, 0)}%</span>
        </div>
        <div className="mono mt-0.5 text-[10.5px] text-dim">
          {fmtNum(kg, 0)} kg · {note}
        </div>
      </div>
    </div>
  );
}
