import clsx from 'clsx';
import { useMemo } from 'react';
import { useDataset } from '../api/hooks';
import type { ManualLog } from '../api/types';
import { BuildingPicker } from '../components/BuildingPicker';
import { ActionsPanel } from '../components/Insights';
import { PageHeader } from '../components/PageHeader';
import { ChartLegend, ResourceChart, useChartFrame } from '../components/ResourceChart';
import { Empty, Panel, Skeleton, Sprite, StatusPill } from '../components/ui';
import { BAG_KG, BUILDING_SPRITE, STREAM_META, type Stream } from '../lib/constants';
import { statusAt, type DataIndex } from '../lib/dataset';
import { fmtInt, fmtNum } from '../lib/format';
import { fmtShort, tToDay, tsToT } from '../lib/time';
import { useTime } from '../store/time';

export default function BuildingDetail() {
  const t = useTime((s) => s.t);
  const id = useTime((s) => s.building);
  const setBuilding = useTime((s) => s.setBuilding);
  const { data: ix } = useDataset();

  if (!ix) return <Skeleton className="h-[70vh]" />;

  return (
    <>
      <PageHeader
        index={2}
        title="Building detail"
        sub="Drill into one building: how it tracks its ghost, what staff noticed on the ground, and how trustworthy its data is."
        right={<BuildingPicker ids={ix.ids} value={id} onChange={setBuilding} />}
      />
      <div className="grid grid-cols-12 gap-4">
        <Facts ix={ix} id={id} t={t} className="col-span-12 xl:col-span-4" />
        <StreamPanel id={id} t={t} stream="electricity" className="col-span-12 xl:col-span-8" />
        <div className="col-span-12 grid gap-4 md:grid-cols-2 xl:col-span-4 xl:grid-cols-1">
          <Quality ix={ix} id={id} t={t} />
          <WasteSplit ix={ix} id={id} t={t} />
        </div>
        <StreamPanel id={id} t={t} stream="water" className="col-span-12 xl:col-span-8" />
        <Notes ix={ix} id={id} t={t} className="col-span-12 xl:col-span-8" />
        <ActionsPanel t={t} buildingFilter={id} className="col-span-12 xl:col-span-4" />
      </div>
    </>
  );
}

function Facts({ ix, id, t, className }: { ix: DataIndex; id: string; t: number; className?: string }) {
  const b = ix.byId.get(id)!;
  const st = statusAt(ix.series[id], t);
  const facts: [string, string][] = [
    ['Type', b.building_type],
    ['Floors', String(b.floors)],
    ['Built area', `${fmtInt(b.area_sqm)} m²`],
    ['Capacity', `${fmtInt(b.design_capacity)} people`],
    ['Solar', b.has_solar ? `${b.solar_capacity_kw} kW rooftop` : 'None'],
    ['Composter', b.has_composter ? 'On site' : 'None'],
    ['Built', String(b.year_built)],
  ];
  return (
    <Panel className={className}>
      <div className="flex items-start justify-between pt-5">
        <Sprite name={BUILDING_SPRITE[id]} size={112} className="animate-bob" grey={st.status === 'offline'} />
        <StatusPill status={st.status} />
      </div>
      <div className="mt-4">
        <div className="mono text-[11px] tracking-[0.1em] text-dim">{id}</div>
        <h2 className="title mt-1 text-[26px]">{b.building_name}</h2>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3">
        {facts.map(([k, v]) => (
          <div key={k} className="border-t border-line pt-2">
            <dt className="eyebrow text-[9.5px]">{k}</dt>
            <dd className="mt-1 text-[14px] text-fg capitalize">{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function StreamPanel({ id, t, stream, className }: { id: string; t: number; stream: Stream; className?: string }) {
  const frame = useChartFrame([id], stream, t, true);
  const anomalies = frame?.rows.filter((r) => r.anomaly && r.t <= t).length ?? 0;
  return (
    <Panel
      className={className}
      title={
        <div>
          <div className="eyebrow">{STREAM_META[stream].label} · {STREAM_META[stream].unit} per hour</div>
          <div className="mt-0.5 text-[15px] font-semibold">Actual vs ghost, then the next 12 h</div>
        </div>
      }
      right={
        <span className={clsx('chip', anomalies ? 'text-alert [--pb:var(--color-alert)]' : 'text-dim')}>
          {anomalies} unusual {anomalies === 1 ? 'reading' : 'readings'}
        </span>
      }
    >
      <ResourceChart frame={frame} stream={stream} now={t} height={230} ticker />
      <div className="mt-2 flex justify-end">
        <ChartLegend />
      </div>
    </Panel>
  );
}

function Quality({ ix, id, t }: { ix: DataIndex; id: string; t: number }) {
  const q = useMemo(() => {
    const s = ix.series[id];
    const c = { real: 0, filled: 0, missing: 0 };
    for (let x = 0; x <= t; x++) c[s.q[x]]++;
    return c;
  }, [ix, id, t]);
  const total = q.real + q.filled + q.missing || 1;
  const parts = [
    { k: 'Real', v: q.real, cls: 'bg-fg' },
    { k: 'Filled in', v: q.filled, cls: 'bg-ghost' },
    { k: 'Missing', v: q.missing, cls: 'bg-alert' },
  ];
  return (
    <Panel title="Data quality · since 20 Jun">
      <div className="flex items-baseline gap-2">
        <span className="num text-[34px]">{fmtNum((q.real / total) * 100, 1)}</span>
        <span className="mono text-[11px] text-dim">% real readings</span>
      </div>
      <div className="mt-3 flex h-2.5 gap-px overflow-hidden">
        {parts.map((p) => (
          <div key={p.k} className={p.cls} style={{ width: `${(p.v / total) * 100}%`, minWidth: p.v ? 3 : 0 }} />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {parts.map((p) => (
          <div key={p.k}>
            <div className="flex items-center gap-1.5">
              <span className={clsx('size-2', p.cls)} />
              <span className="eyebrow text-[9.5px]">{p.k}</span>
            </div>
            <div className="mono mt-1 text-[13px]">{fmtInt(p.v)} h</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-dim">
        Gaps up to 2 h are interpolated; longer gaps stay missing and never earn credits.
      </p>
    </Panel>
  );
}

const WASTE_ROWS = [
  { key: 'wet_organic_kg', label: 'Wet organic', sprite: 'item_food' },
  { key: 'dry_recyclable_kg', label: 'Dry recyclable', sprite: 'item_paper' },
  { key: 'ewaste_kg', label: 'E-waste', sprite: 'item_ewaste' },
  { key: 'hazardous_kg', label: 'Hazardous', sprite: 'item_glass' },
] as const;

function WasteSplit({ ix, id, t }: { ix: DataIndex; id: string; t: number }) {
  const d = ix.dailyBy.get(`${id}|${tToDay(t)}`);
  const vals = WASTE_ROWS.map((r) => ({ ...r, v: (d?.[r.key] as number | null) ?? 0 }));
  const total = vals.reduce((s, r) => s + r.v, 0);
  const max = Math.max(1, ...vals.map((r) => r.v));
  return (
    <Panel title="Today's waste split" right={<span className="mono text-[11px] text-dim">{fmtNum(total, 1)} kg</span>}>
      {!d ? (
        <Empty title="No waste logged today" />
      ) : (
        <ul className="space-y-2.5">
          {vals.map((r) => (
            <li key={r.key} className="flex items-center gap-3">
              <Sprite name={r.sprite} size={24} />
              <span className="w-28 text-[12.5px] text-soft">{r.label}</span>
              <div className="h-2 flex-1 bg-raised">
                <div className="h-full bg-fg/80 transition-[width] duration-300" style={{ width: `${(r.v / max) * 100}%` }} />
              </div>
              <span className="mono w-14 text-right text-[12px]">{fmtNum(r.v, 1)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function logValue(l: ManualLog) {
  if (l.value == null) return 'value missing';
  const u = (l.unit ?? '').toLowerCase();
  const norm = u === 'kl' ? `${fmtInt(l.value * 1000)} L` : u === 'bags' ? `${fmtInt(l.value * BAG_KG)} kg` : null;
  return `${fmtNum(l.value, l.value % 1 ? 1 : 0)} ${l.unit ?? ''}${norm ? ` → ${norm}` : ''}`;
}

function Notes({ ix, id, t, className }: { ix: DataIndex; id: string; t: number; className?: string }) {
  const logs = useMemo(
    () =>
      ix.logs
        .filter((l) => l.building_id === id && tsToT(l.ts) <= t)
        .slice(-14)
        .reverse(),
    [ix, id, t],
  );
  return (
    <Panel className={className} title="Staff log timeline" right={<span className="mono text-[11px] text-dim">latest {logs.length}</span>}>
      {logs.length === 0 ? (
        <Empty sprite="villager" title="No staff logs yet" />
      ) : (
        <ol className="relative ml-2 border-l border-line">
          {logs.map((l, i) => {
            const isNote = l.stream === 'note';
            return (
              <li key={`${l.ts}${i}`} className="relative pb-3.5 pl-5 last:pb-0">
                <span className={clsx('absolute top-1.5 -left-[4.5px] size-2', isNote ? 'bg-alert' : 'bg-line-strong')} />
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="mono text-[11px] text-soft">{fmtShort(tsToT(l.ts))}</span>
                  <span className="mono text-[10px] tracking-[0.08em] text-faint uppercase">
                    {l.logger_role?.replace('_', ' ')} · {l.stream}
                  </span>
                </div>
                <div className={clsx('mt-0.5 text-[13px]', isNote ? 'text-fg' : 'text-dim')}>
                  {isNote ? `“${l.note}”` : `${logValue(l)}${l.note ? ` · ${l.note}` : ''}`}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
