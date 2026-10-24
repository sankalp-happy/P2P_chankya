import clsx from 'clsx';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDataset, useForecast } from '../api/hooks';
import { ActionsPanel, AlertsPanel } from '../components/Insights';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { ChartLegend, ResourceChart, useChartFrame } from '../components/ResourceChart';
import CountUp from '../components/rb/CountUp';
import GlitchText from '../components/rb/GlitchText';
import PixelCard from '../components/rb/PixelCard';
import { Delta, Panel, Skeleton, Spark, Sprite, StatusPill } from '../components/ui';
import { BUILDING_SPRITE, SHORT_NAME, STREAM_META, type Stream, kwhToCo2, kwhToRs, waterToKwh } from '../lib/constants';
import { arrived, statusAt, sumToday, type DataIndex } from '../lib/dataset';
import { fmtCompact, fmtInt, fmtNum } from '../lib/format';
import { fmtClock, tToDay, tsToT } from '../lib/time';
import { useTime } from '../store/time';

export default function Overview() {
  const t = useTime((s) => s.t);
  const { data: ix } = useDataset();
  const [showAll, setShowAll] = useState(false);
  const closeAll = useCallback(() => setShowAll(false), []);
  // Stable element: PageHeader is memoized, and the button reads the clock itself.
  const headerRight = useMemo(() => (ix ? <AllBuildingsButton ix={ix} onOpen={() => setShowAll(true)} /> : null), [ix]);

  if (!ix) return <OverviewSkeleton />;

  return (
    <>
      <PageHeader
        index={1}
        title="Campus overview"
        sub="Eight buildings, one clock. Every number below is what the grid knew at this hour. Only the dotted forecast looks ahead."
        right={headerRight}
      />
      <KpiStrip ix={ix} t={t} />
      {/* items-start: side panels size to their content instead of stretching to the charts */}
      <div className="mt-4 grid grid-cols-12 items-start gap-4">
        <div className="col-span-12 flex flex-col gap-4 xl:col-span-8">
          <BuildingForecast ix={ix} t={t} />
          <CampusForecast ix={ix} t={t} />
        </div>
        <div className="col-span-12 flex flex-col gap-4 xl:col-span-4">
          <AlertsPanel t={t} />
          <ActionsPanel t={t} />
        </div>
      </div>
      <Modal
        open={showAll}
        onClose={closeAll}
        title="All buildings"
        subtitle={<AllBuildingsSubtitle t={t} />}
      >
        <BuildingGrid ix={ix} t={t} onPick={closeAll} />
      </Modal>
    </>
  );
}

function AllBuildingsButton({ ix, onOpen }: { ix: DataIndex; onOpen: () => void }) {
  const t = useTime((s) => s.t);
  const st = ix.ids.map((id) => statusAt(ix.series[id], t).status);
  const offline = st.filter((s) => s === 'offline').length;
  return (
    <button className="btn h-11 gap-3 pr-3 pl-3" onClick={onOpen} aria-haspopup="dialog">
      <svg viewBox="0 0 16 16" className="ml-1 size-4" fill="currentColor" aria-hidden>
        <rect x="1" y="1" width="6" height="6" />
        <rect x="9" y="1" width="6" height="6" />
        <rect x="1" y="9" width="6" height="6" />
        <rect x="9" y="9" width="6" height="6" />
      </svg>
      <span>All buildings</span>
      <span className={clsx('chip h-6', offline ? 'text-alert [--pb:var(--color-alert)]' : 'text-good [--pb:var(--color-good)]')}>
        {offline ? `${offline} offline` : `${ix.ids.length} live`}
      </span>
    </button>
  );
}

function AllBuildingsSubtitle({ t }: { t: number }) {
  const c = fmtClock(t);
  return (
    <>
      Live at {c.day} {c.mon} {c.hh}:00 · click a building to forecast it, double-click for its detail page
    </>
  );
}

function KpiStrip({ ix, t }: { ix: DataIndex; t: number }) {
  const k = useMemo(() => campusToday(ix, t), [ix, t]);
  const y = useMemo(() => campusToday(ix, t - 24), [ix, t]);
  const ch = (a: number, b: number) => (b ? ((a - b) / b) * 100 : NaN);

  const tiles = [
    { label: 'Electricity today', value: k.e, unit: 'kWh', delta: ch(k.e, y.e) },
    { label: 'Water today', value: k.w, unit: 'L', delta: ch(k.w, y.w), compact: true },
    { label: 'Waste today', value: k.waste, unit: 'kg', delta: ch(k.waste, y.waste) },
    { label: 'Cost today', value: k.rs, unit: '₹', delta: ch(k.rs, y.rs), prefix: true },
    { label: 'CO₂ today', value: k.co2, unit: 'kg', delta: ch(k.co2, y.co2) },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
      {tiles.map((x) => (
        <div key={x.label} className="panel px-5 py-4">
          <div className="eyebrow">{x.label}</div>
          <div className="mt-3 flex items-baseline gap-1.5">
            {x.prefix && <span className="num text-[22px] text-dim">₹</span>}
            <CountUp
              to={x.compact ? Math.round(x.value / 100) / 10 : Math.round(x.value)}
              decimals={x.compact ? 1 : 0}
              duration={0.45}
              separator=","
              trigger="load"
              className="num text-[36px]"
            />
            <span className="mono text-[11px] text-dim">{x.compact ? 'kL' : x.prefix ? '' : x.unit}</span>
          </div>
          <div className="mt-2 flex items-center gap-2 whitespace-nowrap">
            <Delta value={x.delta} />
            <span className="mono text-[10px] text-faint">vs same hour yday</span>
          </div>
        </div>
      ))}
      <OnlineTile ix={ix} t={t} />
    </div>
  );
}

function OnlineTile({ ix, t }: { ix: DataIndex; t: number }) {
  const st = ix.ids.map((id) => statusAt(ix.series[id], t).status);
  const online = st.filter((s) => s !== 'offline').length;
  return (
    <div className="panel px-5 py-4">
      <div className="eyebrow">Gateways online</div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className={clsx('num text-[36px]', online < ix.ids.length && 'text-alert')}>{online}</span>
        <span className="mono text-[11px] text-dim">/ {ix.ids.length}</span>
      </div>
      <div className="mt-3 flex gap-1">
        {st.map((s, i) => (
          <span
            key={ix.ids[i]}
            title={`${SHORT_NAME[ix.ids[i]]}: ${s}`}
            className={clsx('h-2 flex-1', s === 'offline' ? 'bg-alert' : s === 'filled' ? 'bg-faint' : 'bg-good')}
          />
        ))}
      </div>
    </div>
  );
}

function campusToday(ix: DataIndex, t: number) {
  if (t < 0) return { e: 0, w: 0, waste: 0, rs: 0, co2: 0 };
  let e = 0;
  let w = 0;
  let waste = 0;
  const day = tToDay(t);
  for (const id of ix.ids) {
    const s = ix.series[id];
    e += sumToday(s.e, s, t);
    w += sumToday(s.w, s, t);
    // Waste is logged per day; spread it across the day in proportion to footfall so far.
    const d = ix.dailyBy.get(`${id}|${day}`);
    if (d) {
      const total = (d.wet_organic_kg ?? 0) + (d.dry_recyclable_kg ?? 0) + (d.ewaste_kg ?? 0) + (d.hazardous_kg ?? 0);
      const d0 = t - (t % 24);
      let all = 0;
      let soFar = 0;
      for (let x = d0; x < d0 + 24; x++) {
        const f = Number.isFinite(s.f[x]) ? s.f[x] : 0;
        all += f;
        if (x <= t) soFar += f;
      }
      waste += all ? (total * soFar) / all : 0;
    }
  }
  const kwh = e + waterToKwh(w);
  return { e, w, waste, rs: kwhToRs(kwh), co2: kwhToCo2(kwh) };
}

function StreamToggle() {
  const stream = useTime((s) => s.stream);
  const setStream = useTime((s) => s.setStream);
  return (
    <div className="seg" role="radiogroup" aria-label="Stream">
      {(['electricity', 'water'] as Stream[]).map((s) => (
        <button key={s} data-on={stream === s} onClick={() => setStream(s)} role="radio" aria-checked={stream === s}>
          {STREAM_META[s].label}
        </button>
      ))}
    </div>
  );
}

function BuildingForecast({ ix, t }: { ix: DataIndex; t: number }) {
  const building = useTime((s) => s.building);
  const stream = useTime((s) => s.stream);
  const setBuilding = useTime((s) => s.setBuilding);
  const frame = useChartFrame([building], stream, t);
  const { data: fc } = useForecast(building, stream, t);
  const spike = fc?.find((p) => p.is_spike);
  const peak = spike ? fc!.reduce((m, p) => (p.is_spike && p.predicted > m.predicted ? p : m), spike) : null;
  const next12 = fc?.reduce((s, p) => s + p.predicted, 0) ?? 0;
  const unit = STREAM_META[stream].unit;
  const b = ix.byId.get(building)!;

  return (
    <Panel
      title={
        <div className="flex items-center gap-3">
          <Sprite name={BUILDING_SPRITE[building]} size={34} />
          <div>
            <div className="eyebrow">Forecast · next 12 h</div>
            <div className="mt-0.5 text-[15px] font-semibold">{b.building_name}</div>
          </div>
        </div>
      }
      right={
        <div className="flex items-center gap-3">
          <div className="hidden gap-1 lg:flex" role="radiogroup" aria-label="Building">
            {ix.ids.map((id) => (
              <button
                key={id}
                onClick={() => setBuilding(id)}
                role="radio"
                aria-checked={building === id}
                title={SHORT_NAME[id]}
                data-on={building === id}
                className="chip-btn"
              >
                {id}
              </button>
            ))}
          </div>
          <StreamToggle />
        </div>
      }
    >
      <ResourceChart frame={frame} stream={stream} now={t} height={290} ticker />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        {peak ? (
          <div className="flex items-center gap-2.5">
            <span className="size-2.5 rounded-full bg-alert" />
            <span className="text-[13px] text-fg">
              Spike predicted at {fmtClock(tsToT(peak.ts)).hh}:00{' '}
              <span className="text-dim">(in {tsToT(peak.ts) - t} h)</span>: {fmtNum(peak.predicted, 0)} {unit}/h,{' '}
              range {fmtNum(peak.low, 0)}–{fmtNum(peak.high, 0)}
            </span>
          </div>
        ) : (
          <span className="text-[13px] text-dim">No spikes predicted in the next 12 h.</span>
        )}
        <div className="flex items-center gap-5">
          <span className="mono text-[11px] text-dim">
            Next 12 h <span className="text-fg">{fmtInt(next12)} {unit}</span>
          </span>
          <ChartLegend />
        </div>
      </div>
    </Panel>
  );
}

function CampusForecast({ ix, t }: { ix: DataIndex; t: number }) {
  const stream = useTime((s) => s.stream);
  const frame = useChartFrame(ix.ids, stream, t);
  const offline = ix.ids.filter((id) => statusAt(ix.series[id], t).status === 'offline');
  return (
    <Panel
      title={
        <div>
          <div className="eyebrow">Campus · all 8 buildings</div>
          <div className="mt-0.5 text-[15px] font-semibold">{STREAM_META[stream].label}, actual vs forecast</div>
        </div>
      }
      right={
        offline.length > 0 ? (
          <span className="mono text-[10.5px] text-alert">
            {offline.map((id) => SHORT_NAME[id]).join(', ')} at ghost value (offline)
          </span>
        ) : (
          <span className="mono text-[10.5px] text-dim">All gateways reporting</span>
        )
      }
    >
      <ResourceChart frame={frame} stream={stream} now={t} height={170} compact />
    </Panel>
  );
}

function BuildingGrid({ ix, t, onPick }: { ix: DataIndex; t: number; onPick: () => void }) {
  const building = useTime((s) => s.building);
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {ix.ids.map((id) => (
        <BuildingCard key={id} ix={ix} id={id} t={t} selected={building === id} onPick={onPick} />
      ))}
    </div>
  );
}

function BuildingCard({ ix, id, t, selected, onPick }: { ix: DataIndex; id: string; t: number; selected: boolean; onPick: () => void }) {
  const navigate = useNavigate();
  const s = ix.series[id];
  const b = ix.byId.get(id)!;
  const st = statusAt(s, t);
  const last = st.lastT;
  const d = ix.dailyBy.get(`${id}|${tToDay(t)}`);
  const waste = d ? (d.wet_organic_kg ?? 0) + (d.dry_recyclable_kg ?? 0) + (d.ewaste_kg ?? 0) + (d.hazardous_kg ?? 0) : NaN;
  const spark = useMemo(() => {
    const out: number[] = [];
    for (let x = t - 23; x <= t; x++) out.push(x >= 0 && arrived(s, x, t) ? s.e[x] : NaN);
    return out;
  }, [s, t]);
  const offline = st.status === 'offline';

  return (
    <PixelCard
      radius={0}
      gap={7}
      speed={30}
      colors={['#1b2a25', '#22362f', '#2c473d']}
      intro={false}
      noFocus
      className={clsx('panel', selected && '[--pb:var(--color-ghost)]', offline && '[--pb:var(--color-alert)]')}
    >
      <button
        className="block w-full p-4 text-left"
        onClick={(e) => {
          useTime.getState().setBuilding(id);
          // a double-click's first click shouldn't close the dialog before the second arrives
          if (e.detail === 1) window.setTimeout(onPick, 220);
        }}
        onDoubleClick={() => navigate('/building')}
        aria-pressed={selected}
        title="Click to forecast · double-click for detail"
      >
        <div className="flex items-start justify-between">
          <Sprite name={BUILDING_SPRITE[id]} size={52} grey={offline} />
          <StatusPill status={st.status} />
        </div>
        <div className="mt-3">
          <div className="mono text-[10px] tracking-[0.1em] text-dim">
            {id} · {b.building_type.toUpperCase()}
          </div>
          <div className="mt-0.5 truncate text-[15px] font-semibold">
            {offline ? <GlitchText color="#ff6a4d" fontSize={15} fontWeight={600} mode="slices" intensity={0.6}>{SHORT_NAME[id]}</GlitchText> : SHORT_NAME[id]}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Metric label="Power" value={Number.isFinite(s.e[last]) ? fmtNum(s.e[last], 1) : '—'} unit="kWh" />
          <Metric label="Water" value={Number.isFinite(s.w[last]) ? fmtCompact(s.w[last]) : '—'} unit="L" />
          <Metric label="Waste" value={Number.isFinite(waste) ? fmtInt(waste) : '—'} unit="kg/d" />
        </div>
        <div className="mt-3 flex items-end justify-between text-dim">
          <Spark values={spark} width={130} height={26} className={offline ? 'text-alert/70' : 'text-soft'} />
          <span className="mono text-[9.5px] text-faint">{offline ? `${st.staleH} h buffered` : '24 h'}</span>
        </div>
      </button>
    </PixelCard>
  );
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div>
      <div className="mono text-[9px] tracking-[0.12em] text-faint uppercase">{label}</div>
      <div className="num mt-1 text-[19px]">{value}</div>
      <div className="mono text-[9px] text-dim">{unit}</div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-16 w-80" />
      <div className="grid grid-cols-6 gap-4">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <div className="grid grid-cols-12 gap-4">
        <Skeleton className="col-span-8 h-96" />
        <Skeleton className="col-span-4 h-96" />
      </div>
    </div>
  );
}

