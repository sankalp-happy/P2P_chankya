import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useDataset, useForecasts, useHistories } from '../api/hooks';
import { STREAM_META, type Stream } from '../lib/constants';
import { arrived } from '../lib/dataset';
import { fmtCompact, fmtNum } from '../lib/format';
import { HOURS, fmtClock, hourOf, tsToT } from '../lib/time';
import { useTime } from '../store/time';

export interface ChartRow {
  t: number;
  actual: number | null;
  ghost: number | null;
  pred: number | null;
  band: [number, number] | null;
  spike: boolean;
  offline: boolean;
  anomaly: boolean;
}

const HORIZON = 12;

/**
 * Fixed window: yesterday 00:00 -> today 00:00 + 36 h. The axis only moves at midnight;
 * in between, NOW walks right and the actual line draws in hour by hour.
 */
export function chartWindow(t: number): [number, number] {
  const today = t - hourOf(t);
  return [Math.max(0, today - 24), Math.min(HOURS - 1, today + 36)];
}

interface Frame {
  key: string;
  rows: ChartRow[];
  window: [number, number];
  /** The hour this frame was built for. The chart draws NOW from here, never from a newer prop. */
  now: number;
}

/** Builds one consistent frame for a building (or the campus sum when `ids` has several). */
export function useChartFrame(ids: string[], stream: Stream, t: number, markAnomalies = false): Frame | null {
  const { data: ix } = useDataset();
  const [w0, w1] = chartWindow(t);
  const fq = useForecasts(ids, stream, t, HORIZON);
  const hq = useHistories(ids, stream, w0, w1);
  const last = useRef<Frame | null>(null);

  // Actuals always come from local data at hour t, so the chart moves every tick. The forecast is the
  // newest one available (it may be from a slightly earlier hour while the backend catches up); only its
  // points after t are drawn, so nothing is misaligned.
  const ready = !!ix && !!fq.data;
  const fcData = fq.data ?? [];
  const histData = (hq.isError ? [] : hq.data) ?? [];
  const key = `${ids.join()}|${stream}|${markAnomalies}`;

  const frame = useMemo<Frame | null>(() => {
    if (!ready || !ix) return null;
    const ghostAt = ids.map((_, i) => new Map((histData[i] ?? []).map((p) => [tsToT(p.ts), p.predicted])));
    const fcAt = ids.map((_, i) => new Map((fcData[i] ?? []).map((p) => [tsToT(p.ts), p])));
    const hasGhost = histData.some((h) => h?.length);
    const spikes = ids.length === 1 ? (fcData[0] ?? []).filter((p) => p.is_spike) : [];
    const peakT = spikes.length ? tsToT(spikes.reduce((m, p) => (p.predicted > m.predicted ? p : m)).ts) : null;

    const rows: ChartRow[] = [];
    for (let x = w0; x <= Math.min(w1, t + HORIZON); x++) {
      const row: ChartRow = { t: x, actual: null, ghost: null, pred: null, band: null, spike: false, offline: false, anomaly: false };
      if (x <= t) {
        let sum = 0;
        let g = 0;
        let anyArrived = false;
        ids.forEach((id, i) => {
          const s = ix.series[id];
          const a = stream === 'electricity' ? s.e : s.w;
          const gv = ghostAt[i].get(x);
          if (gv != null) g += gv;
          if (arrived(s, x, t) && Number.isFinite(a[x])) {
            sum += a[x];
            anyArrived = true;
          } else {
            row.offline = true;
            if (ids.length > 1 && gv != null) sum += gv; // campus: an offline building counts at its ghost
          }
        });
        row.actual = anyArrived ? sum : null;
        row.ghost = hasGhost ? g : null;
        if (markAnomalies && row.actual != null && row.ghost != null) {
          const floor = stream === 'electricity' ? 2 : 60;
          row.anomaly = Math.abs(row.actual - row.ghost) > Math.max(0.35 * row.ghost, floor);
        }
      }
      if (x === t) {
        row.pred = row.actual ?? row.ghost;
        if (row.pred != null) row.band = [row.pred, row.pred];
      } else if (x > t) {
        let p = 0;
        let lo = 0;
        let hi = 0;
        let n = 0;
        fcAt.forEach((m) => {
          const f = m.get(x);
          if (!f) return;
          p += f.predicted;
          lo += f.low;
          hi += f.high;
          n++;
        });
        if (n) {
          row.pred = p;
          row.band = [lo, hi];
          row.spike = x === peakT;
        }
      }
      rows.push(row);
    }
    return { key, rows, window: [w0, w1], now: t };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ix, key, t, w0, w1, markAnomalies, fq.data, hq.data]);

  if (frame) last.current = frame;
  return frame ?? last.current;
}

function offlineRuns(rows: ChartRow[], now: number) {
  const runs: [number, number][] = [];
  let start: number | null = null;
  for (const r of rows) {
    if (r.t > now) break;
    if (r.offline && start == null) start = r.t;
    if (!r.offline && start != null) {
      runs.push([start - 0.5, r.t - 0.5]);
      start = null;
    }
  }
  if (start != null) runs.push([start - 0.5, now + 0.5]);
  return runs;
}

function niceCeil(x: number) {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m <= 1 ? 1 : m <= 1.5 ? 1.5 : m <= 2 ? 2 : m <= 3 ? 3 : m <= 4 ? 4 : m <= 5 ? 5 : m <= 6 ? 6 : m <= 8 ? 8 : 10) * p;
}

/** Y max that only grows, or shrinks when the data clearly calls for it, so lines don't jump per tick. */
function useStableMax(frame: Frame | null) {
  const ref = useRef<{ key: string; max: number } | null>(null);
  if (!frame) return ref.current?.max ?? 1;
  let m = 0;
  for (const r of frame.rows) m = Math.max(m, r.actual ?? 0, r.ghost ?? 0, r.band?.[1] ?? 0, r.pred ?? 0);
  const target = niceCeil(m * 1.08);
  const cur = ref.current;
  if (!cur || cur.key !== frame.key || target > cur.max || target < cur.max * 0.55) ref.current = { key: frame.key, max: target };
  return ref.current!.max;
}

const GOOD = '#2fe08a';
const BAD = '#ff4d5e';
const GHOST = '#a99bff';
const CANDLE_H = 3;

interface Plot extends ChartRow {
  candle?: [number, number];
  o?: number;
  c?: number;
}

interface Stock {
  rows: Plot[];
  stops: { o: number; c: string }[];
  last: Plot | null;
  lastColor: string;
  change24: number;
}

/** Direction colours per hour (down = green, up = red), 3 h candles and the "last price". */
function useStock(frame: Frame | null, now: number): Stock | null {
  return useMemo(() => {
    if (!frame) return null;
    const rows: Plot[] = frame.rows.map((r) => ({ ...r }));
    const pts = rows.filter((r) => r.t <= now && r.actual != null);
    const stops: Stock['stops'] = [];
    if (pts.length >= 2) {
      const a = pts[0].t;
      const span = pts[pts.length - 1].t - a || 1;
      for (let i = 0; i < pts.length - 1; i++) {
        const col = pts[i + 1].actual! > pts[i].actual! ? BAD : GOOD;
        stops.push({ o: (pts[i].t - a) / span, c: col }, { o: (pts[i + 1].t - a) / span, c: col });
      }
    }
    const buckets = new Map<number, Plot[]>();
    for (const r of pts) {
      const k = r.t - (r.t % CANDLE_H);
      buckets.set(k, [...(buckets.get(k) ?? []), r]);
    }
    const at = new Map(rows.map((r) => [r.t, r]));
    buckets.forEach((b, k) => {
      const host = at.get(k + 1) ?? at.get(k);
      if (!host) return;
      const vals = b.map((r) => r.actual!);
      host.candle = [Math.min(...vals), Math.max(...vals)];
      host.o = vals[0];
      host.c = vals[vals.length - 1];
    });
    const last = pts[pts.length - 1] ?? null;
    const prev = pts[pts.length - 2];
    const dayAgo = last ? at.get(last.t - 24)?.actual : null;
    return {
      rows,
      stops,
      last,
      lastColor: last && prev && last.actual! > prev.actual! ? BAD : GOOD,
      change24: last && dayAgo ? ((last.actual! - dayAgo) / dayAgo) * 100 : NaN,
    };
  }, [frame, now]);
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Predicted peak: solid coral dot, a slow pulse ring, and a label. */
function PeakMarker({ cx, cy }: { cx: number; cy: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={5} fill="none" stroke="#ff6a4d" strokeWidth={1.5}>
        <animate attributeName="r" values="5;14" dur="1.8s" repeatCount="indefinite" />
        <animate attributeName="stroke-opacity" values="0.7;0" dur="1.8s" repeatCount="indefinite" />
      </circle>
      <circle cx={cx} cy={cy} r={4.5} fill="#ff6a4d" stroke="#0c0d0f" strokeWidth={2} />
      <text x={cx} y={cy - 13} textAnchor="middle" fontSize={9.5} fontWeight={700} fontFamily="JetBrains Mono" letterSpacing={1.5} fill="#ff6a4d">
        PEAK
      </text>
    </g>
  );
}

function Candle(p:{ x?: number; y?: number; width?: number; height?: number; payload?: Plot }) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = p;
  if (!payload?.candle || payload.o == null || payload.c == null) return <g />;
  const [l, h] = payload.candle;
  const col = payload.c > payload.o ? BAD : GOOD;
  const span = h - l || 1;
  const top = y + ((h - Math.max(payload.o, payload.c)) / span) * height;
  const bot = y + ((h - Math.min(payload.o, payload.c)) / span) * height;
  const cx = x + width / 2;
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + Math.max(1, height)} stroke={col} strokeWidth={1.25} />
      <rect x={x} y={top} width={width} height={Math.max(2, bot - top)} fill={col} />
    </g>
  );
}

interface ChartProps {
  frame: Frame | null;
  stream: Stream;
  now: number;
  height?: number;
  compact?: boolean;
  ticker?: boolean;
}

// Re-render only when a new complete frame arrives (or layout props change). `now` is read from
// the frame, so a newer clock prop alone never redraws a chart with stale data.
export const ResourceChart = memo(
  ResourceChartImpl,
  (a: ChartProps, b: ChartProps) =>
    a.frame === b.frame && a.stream === b.stream && a.height === b.height && a.compact === b.compact && a.ticker === b.ticker && (a.frame != null || a.now === b.now),
);

function ResourceChartImpl({
  frame,
  stream,
  now: nowProp,
  height = 280,
  compact,
  ticker,
}: ChartProps) {
  const now = frame?.now ?? nowProp;
  const unit = STREAM_META[stream].unit;
  const mode = useTime((s) => s.chartMode);
  const yMax = useStableMax(frame);
  const stock = useStock(frame, now);
  const gid = useId().replace(/:/g, '');
  const [boxRef, width] = useWidth();
  const [w0, w1] = frame?.window ?? chartWindow(now);
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let x = Math.ceil(w0 / 6) * 6; x <= w1; x += 6) out.push(x);
    return out;
  }, [w0, w1]);

  if (!frame || !stock) return <div style={{ height }} className="animate-pulse bg-raised" />;
  const runs = offlineRuns(frame.rows, now);
  const hasAnomaly = frame.rows.some((r) => r.anomaly);
  const firstPred = stock.rows.findIndex((r) => r.t === now + 2 && r.pred != null);
  const candles = mode === 'candles' && !compact;
  const candleW = Math.max(3, ((width - (compact ? 42 : 48)) / Math.max(1, w1 - w0)) * CANDLE_H * 0.62);

  return (
    <div>
      {ticker && <Ticker stock={stock} unit={unit} />}
      <div ref={boxRef} style={{ height }} className="relative">
        <ResponsiveContainer width="100%" height="100%" debounce={60}>
          <ComposedChart data={stock.rows} margin={{ top: 18, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <pattern id={`${gid}h`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" stroke="#ff6a4d" strokeOpacity="0.35" strokeWidth="2" />
              </pattern>
              <linearGradient id={`${gid}b`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={GHOST} stopOpacity={0.2} />
                <stop offset="100%" stopColor={GHOST} stopOpacity={0.04} />
              </linearGradient>
              {/* Hard colour stops: each hour's segment is red if usage rose, green if it fell. */}
              <linearGradient id={`${gid}d`} x1="0" y1="0" x2="1" y2="0">
                {stock.stops.map((st, i) => (
                  <stop key={i} offset={st.o} stopColor={st.c} />
                ))}
              </linearGradient>
              <filter id={`${gid}g`} x="-5%" y="-60%" width="110%" height="220%">
                <feGaussianBlur stdDeviation="3" />
              </filter>
            </defs>
            <CartesianGrid vertical={false} stroke="#1d2125" strokeDasharray="2 5" />
            <XAxis
              dataKey="t"
              type="number"
              domain={[w0, w1]}
              ticks={ticks}
              allowDataOverflow
              tickFormatter={(x: number) => (hourOf(x) === 0 ? `${fmtClock(x).day} ${fmtClock(x).mon}` : `${String(hourOf(x)).padStart(2, '0')}:00`)}
              tick={{ fill: '#6f7770', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              axisLine={{ stroke: '#2b3036' }}
              tickLine={false}
              interval={0}
            />
            <YAxis
              orientation="right"
              width={compact ? 42 : 48}
              domain={[0, yMax]}
              tickCount={5}
              allowDataOverflow
              tickFormatter={(v: number) => fmtCompact(v)}
              tick={{ fill: '#6f7770', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              axisLine={false}
              tickLine={false}
            />
            {runs.map(([a, b]) => (
              <ReferenceArea key={a} x1={a} x2={b} fill={`url(#${gid}h)`} stroke="none" ifOverflow="hidden" />
            ))}
            <ReferenceArea x1={now} x2={w1} fill={GHOST} fillOpacity={0.03} stroke="none" ifOverflow="hidden" />
            <Area dataKey="band" stroke="none" fill={`url(#${gid}b)`} isAnimationActive={false} connectNulls />
            <Line dataKey="ghost" stroke={GHOST} strokeOpacity={0.6} strokeWidth={2} strokeDasharray="0.1 5" strokeLinecap="round" dot={false} activeDot={false} isAnimationActive={false} connectNulls />
            {!candles && (
              <Line
                dataKey="actual"
                stroke={stock.stops.length ? `url(#${gid}d)` : '#e8ebe6'}
                strokeWidth={2}
                strokeLinejoin="round"
                isAnimationActive={false}
                connectNulls={false}
                dot={
                  hasAnomaly
                    ? (p: { cx?: number; cy?: number; payload?: ChartRow; index?: number }) =>
                        p.payload?.anomaly && p.cx != null && p.cy != null ? (
                          <circle key={`a${p.index}`} cx={p.cx} cy={p.cy} r={4} fill="#0c0d0f" stroke="#ff6a4d" strokeWidth={1.75} />
                        ) : (
                          <g key={`a${p.index}`} />
                        )
                    : false
                }
                activeDot={{ r: 3.5, fill: '#e8ebe6', stroke: '#0c0d0f', strokeWidth: 2 }}
              />
            )}
            {candles && <Bar dataKey="candle" barSize={candleW} shape={Candle} isAnimationActive={false} />}
            {/* soft glow track under the dotted forecast, so the dots read as one path */}
            <Line dataKey="pred" stroke={GHOST} strokeOpacity={0.22} strokeWidth={7} strokeLinecap="round" filter={`url(#${gid}g)`} dot={false} activeDot={false} isAnimationActive={false} connectNulls />
            <Line
              dataKey="pred"
              stroke={GHOST}
              strokeWidth={3.5}
              strokeDasharray="0.1 7"
              strokeLinecap="round"
              isAnimationActive={false}
              connectNulls
              dot={(p: { cx?: number; cy?: number; payload?: ChartRow; index?: number }) => {
                if (p.cx == null || p.cy == null) return <g key={`n${p.index}`} />;
                if (p.payload?.spike) return <PeakMarker key={`s${p.index}`} cx={p.cx} cy={p.cy} />;
                if (p.index === firstPred && !compact)
                  return (
                    <text key={`e${p.index}`} x={p.cx} y={p.cy - 12} textAnchor="start" fontSize={9.5} fontWeight={600} fontFamily="JetBrains Mono" letterSpacing={1.5} fill={GHOST}>
                      FORECAST
                    </text>
                  );
                return <g key={`n${p.index}`} />;
              }}
              activeDot={{ r: 4, fill: GHOST, stroke: '#0c0d0f', strokeWidth: 2 }}
            />
            <ReferenceLine
              x={now}
              stroke={GHOST}
              strokeWidth={1.25}
              label={{ value: 'NOW', position: 'top', fill: GHOST, fontSize: 10, fontFamily: 'JetBrains Mono', letterSpacing: 2 }}
            />
            {!candles && stock.last?.actual != null && (
              <ReferenceDot x={stock.last.t} y={stock.last.actual} r={4} fill={stock.lastColor} stroke="#0c0d0f" strokeWidth={2} ifOverflow="hidden" />
            )}
            <Tooltip
              cursor={{ stroke: '#5c635d', strokeWidth: 1, strokeDasharray: '3 3' }}
              isAnimationActive={false}
              content={({ active, payload }) => {
                const r = (payload?.[0]?.payload ?? null) as Plot | null;
                if (!active || !r) return null;
                const c = fmtClock(r.t);
                const future = r.t > now;
                const prev = stock.rows.find((x) => x.t === r.t - 1)?.actual;
                const move = !future && r.actual != null && prev != null ? r.actual - prev : null;
                return (
                  <div className="pixel min-w-[200px] px-3 py-2.5 [--pb:var(--color-line-strong)] [--pf:var(--color-bg)] [--px:4px]">
                    <div className="eyebrow mb-1.5 text-[10px]">
                      {c.dow} {c.day} {c.mon} · {c.hh}:00 {future ? '· forecast' : ''}
                    </div>
                    {!future && <TipRow label="Actual" value={r.actual} unit={unit} strong />}
                    {move != null && (
                      <div className="flex items-baseline justify-between gap-4 text-[12px]">
                        <span className="text-dim">vs prev hour</span>
                        <span className="mono" style={{ color: move > 0 ? BAD : GOOD }}>
                          {move > 0 ? '▲' : '▼'} {fmtNum(Math.abs(move), 1)} {unit}
                        </span>
                      </div>
                    )}
                    {candles && r.candle && r.o != null && r.c != null && (
                      <TipRow label="3 h O / H / L / C" value={null} text={`${fmtNum(r.o, 0)} ${fmtNum(r.candle[1], 0)} ${fmtNum(r.candle[0], 0)} ${fmtNum(r.c, 0)}`} />
                    )}
                    {!future && r.ghost != null && <TipRow label="Ghost" value={r.ghost} unit={unit} />}
                    {future && <TipRow label="Predicted" value={r.pred} unit={unit} strong />}
                    {future && r.band && <TipRow label="Range" value={null} text={`${fmtNum(r.band[0], 0)}–${fmtNum(r.band[1], 0)} ${unit}`} />}
                    {r.offline && !future && <div className="mono mt-1 text-[10px] text-alert">Offline · reading buffered</div>}
                    {r.spike && <div className="mono mt-1 text-[10px] text-alert">● Predicted peak</div>}
                    {r.anomaly && <div className="mono mt-1 text-[10px] text-alert">○ Unusual vs ghost</div>}
                  </div>
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Ticker({ stock, unit }: { stock: Stock; unit: string }) {
  const mode = useTime((s) => s.chartMode);
  const setMode = useTime((s) => s.setChartMode);
  const v = stock.last?.actual;
  const up = stock.change24 > 0;
  return (
    <div className="mb-1 flex items-end justify-between gap-4">
      <div className="flex items-baseline gap-3">
        <span className="num text-[34px]">
          {v != null ? fmtNum(v, v < 100 ? 1 : 0) : '—'}
        </span>
        <span className="mono text-[11px] text-dim">{unit}/h now</span>
        {Number.isFinite(stock.change24) && (
          <span className="mono text-[12px]" style={{ color: up ? BAD : GOOD }}>
            {up ? '▲' : '▼'} {fmtNum(Math.abs(stock.change24), 1)}% <span className="text-faint">vs 24 h ago</span>
          </span>
        )}
      </div>
      <div className="seg" role="radiogroup" aria-label="Chart type">
        <button data-on={mode === 'line'} onClick={() => setMode('line')}>
          Line
        </button>
        <button data-on={mode === 'candles'} onClick={() => setMode('candles')}>
          Candles
        </button>
      </div>
    </div>
  );
}

function TipRow({ label, value, unit, text, strong }: { label: string; value: number | null; unit?: string; text?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-[12px]">
      <span className="text-dim">{label}</span>
      <span className={strong ? 'mono text-fg' : 'mono text-soft'}>{text ?? (value == null ? '—' : `${fmtNum(value, 1)} ${unit}`)}</span>
    </div>
  );
}

export function ChartLegend({ className }: { className?: string }) {
  return (
    <div className={`mono flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] tracking-[0.08em] text-dim uppercase ${className ?? ''}`}>
      <span className="inline-flex items-center gap-1.5">
        <span className="flex h-[2px] w-4">
          <span className="flex-1 bg-good" />
          <span className="flex-1 bg-bad" />
        </span>
        Down / up
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="w-4 border-t-[3px] border-dotted border-ghost" /> Forecast
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="w-4 border-t-2 border-dotted border-ghost/60" /> Ghost
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-4 bg-ghost/15" /> Range
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-alert" /> Peak
      </span>
    </div>
  );
}
