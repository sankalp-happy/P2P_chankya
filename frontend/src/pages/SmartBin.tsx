import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useBinEvents, useClassifierMetrics } from '../api/hooks';
import type { BinEvent, ClassifierMetrics, Prediction } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import CountUp from '../components/rb/CountUp';
import { Empty, Panel, Skeleton, Sprite } from '../components/ui';
import { MANUAL_SORT_BELOW, SHORT_NAME, WASTE_CLASSES, WASTE_META, type WasteClass } from '../lib/constants';
import { fmtNum } from '../lib/format';
import { tToTs } from '../lib/time';
import { useTime } from '../store/time';

interface Sorted {
  ev: BinEvent;
  pred: Prediction;
}

const RATES = [1, 3, 8] as const;
const SENSORS: { key: keyof BinEvent; label: string; unit: string; d: number }[] = [
  { key: 'weight_g', label: 'Weight', unit: 'g', d: 0 },
  { key: 'moisture_pct', label: 'Moisture', unit: '%', d: 1 },
  { key: 'metal_signal', label: 'Metal', unit: '', d: 1 },
  { key: 'transparency', label: 'Transparency', unit: '', d: 2 },
  { key: 'acoustic_hardness', label: 'Hardness', unit: '', d: 2 },
];

const destSprite = (p: Prediction) => (p.route === 'manual_sort' ? 'villager' : p.label === 'food_organic' ? 'composter' : 'recycle_chest');

export default function SmartBin() {
  const t = useTime((s) => s.t);
  const { data: events } = useBinEvents();
  const { data: metrics } = useClassifierMetrics();
  const [running, setRunning] = useState(false);
  const [rate, setRate] = useState<(typeof RATES)[number]>(3);
  const [feed, setFeed] = useState<Sorted[]>([]);
  const [counts, setCounts] = useState<Record<WasteClass, number>>(() => Object.fromEntries(WASTE_CLASSES.map((c) => [c, 0])) as Record<WasteClass, number>);
  const [stats, setStats] = useState({ n: 0, manual: 0, ms: 0 });
  const cursor = useRef<number | null>(null);
  const inFlight = useRef(false);

  const startIdx = useMemo(() => {
    if (!events) return 0;
    const ts = tToTs(t);
    const i = events.findIndex((e) => e.timestamp >= ts);
    return i < 0 ? 0 : i;
  }, [events, t]);

  const ranges = useMemo(() => {
    const r: Record<string, number> = {};
    for (const s of SENSORS) r[s.key] = Math.max(1, ...(events ?? []).map((e) => (e[s.key] as number | null) ?? 0));
    return r;
  }, [events]);

  useEffect(() => {
    if (!running || !events) return;
    let alive = true;
    const id = window.setInterval(async () => {
      if (inFlight.current) return; // live predict can take longer than one tick
      const i = cursor.current ?? startIdx;
      if (i >= events.length) return setRunning(false);
      cursor.current = i + 1;
      const ev = events[i];
      inFlight.current = true;
      const pred = await api.predict(ev).finally(() => (inFlight.current = false));
      if (!alive) return;
      setFeed((f) => [{ ev, pred }, ...f].slice(0, 40));
      setCounts((c) => ({ ...c, [pred.label]: c[pred.label] + 1 }));
      setStats((s) => ({ n: s.n + 1, manual: s.manual + (pred.route === 'manual_sort' ? 1 : 0), ms: s.ms + pred.time_ms }));
    }, 1000 / rate);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [running, rate, events, startIdx]);

  const reset = () => {
    setRunning(false);
    cursor.current = null;
    setFeed([]);
    setCounts(Object.fromEntries(WASTE_CLASSES.map((c) => [c, 0])) as Record<WasteClass, number>);
    setStats({ n: 0, manual: 0, ms: 0 });
  };

  if (!events) return <Skeleton className="h-[70vh]" />;
  const cur = feed[0];

  return (
    <>
      <PageHeader
        index={3}
        title="Smart bin · live"
        sub="Every item dropped into a campus bin is read by five cheap sensors and sorted on the edge in milliseconds. Low-confidence items go to a human instead of the wrong bin."
        right={
          <div className="flex items-center gap-3">
            <div className="seg" role="radiogroup" aria-label="Events per second">
              {RATES.map((r) => (
                <button key={r} data-on={rate === r} onClick={() => setRate(r)}>
                  {r}/s
                </button>
              ))}
            </div>
            <button className="btn" onClick={reset} disabled={!stats.n}>
              Reset
            </button>
            <button className={clsx('btn min-w-[120px]', running ? 'btn-alert' : 'btn-ghost')} onClick={() => setRunning((r) => !r)}>
              {running ? 'Pause' : stats.n ? 'Resume' : 'Start feed'}
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-12 gap-4">
        <Panel className="col-span-12 xl:col-span-8" title="Current item" right={<span className="mono text-[11px] text-dim">feed from {tToTs(t).slice(0, 10)} · {events.length - startIdx} events queued</span>}>
          {!cur ? (
            <Empty sprite="hopper" title="Bin is idle" detail="Press Start feed to stream real test events through the classifier." />
          ) : (
            <CurrentItem cur={cur} ranges={ranges} />
          )}
        </Panel>

        <Panel className="col-span-12 xl:col-span-4" title="Sorted so far" right={<span className="mono text-[11px] text-dim">{stats.n} items</span>}>
          <div className="grid grid-cols-3 gap-2">
            {WASTE_CLASSES.map((c) => (
              <div key={c} className="pixel p-3 [--pf:var(--color-bg)] [--px:4px]">
                <Sprite name={WASTE_META[c].sprite} size={28} />
                <div className="num mt-2 text-[24px]">
                  <CountUp to={counts[c]} duration={0.3} trigger="load" />
                </div>
                <div className="mono mt-1 text-[9.5px] tracking-[0.06em] text-dim uppercase">{WASTE_META[c].label}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Stat label="To manual sort" value={`${stats.manual}`} sub={stats.n ? `${fmtNum((stats.manual / stats.n) * 100, 1)}% of items` : '—'} />
            <Stat label="Avg time / item" value={stats.n ? `${fmtNum(stats.ms / stats.n, 2)}` : '—'} sub="ms · target < 2,000" />
          </div>
        </Panel>

        <Panel className="col-span-12 xl:col-span-8" title="Event feed">
          <Feed feed={feed} />
        </Panel>

        <Scorecard metrics={metrics} className="col-span-12 xl:col-span-4" />
      </div>
    </>
  );
}

function CurrentItem({ cur, ranges }: { cur: Sorted; ranges: Record<string, number> }) {
  const { ev, pred } = cur;
  const meta = WASTE_META[pred.label];
  const sure = pred.route === 'bin';
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_1fr]">
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="relative grid place-items-center">
          <AnimatePresence mode="popLayout">
            <motion.div
              key={ev.event_id}
              initial={{ y: -40, opacity: 0, rotate: -8 }}
              animate={{ y: 0, opacity: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 22 }}
              className="absolute -top-10"
            >
              <Sprite name={meta.sprite} size={40} />
            </motion.div>
          </AnimatePresence>
          <Sprite name="hopper" size={92} />
          <span className="mono mt-2 text-[10px] text-dim">{ev.bin_id}</span>
        </div>
        <div className="flex flex-1 flex-col items-center gap-1">
          <div className="mono text-[10px] text-ghost">{fmtNum(pred.time_ms, 2)} ms</div>
          <div className="h-px w-full bg-gradient-to-r from-line-strong via-ghost to-line-strong" />
          <div className="mono text-[10px] text-dim">{pred.source === 'live' ? 'live API round trip' : 'edge inference'}</div>
        </div>
        <div className="grid place-items-center">
          <Sprite name={destSprite(pred)} size={92} />
          <span className={clsx('mono mt-2 text-[10px]', sure ? 'text-soft' : 'text-alert')}>{sure ? meta.bin : 'Manual sort'}</span>
        </div>
      </div>

      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="eyebrow">Predicted</div>
            <div className="title mt-1 text-[26px]">{meta.label}</div>
            <div className="mono mt-1 text-[11px] text-dim">
              {ev.event_id} · {SHORT_NAME[ev.building_id]} · {ev.timestamp.slice(5, 16)}
            </div>
          </div>
          <span className={clsx('chip', sure ? 'text-ghost [--pb:var(--color-ghost)]' : 'text-alert [--pb:var(--color-alert)]')}>
            {sure ? 'Routed to bin' : 'Manual sort'}
          </span>
        </div>
        <ConfidenceBar value={pred.confidence} />
        {pred.explanation && (
          <div className="pixel mt-4 p-3 [--pb:var(--color-ghost)] [--pf:var(--color-bg)] [--px:4px]">
            <div className="eyebrow mb-1 text-[9.5px] text-ghost">Why · model explanation</div>
            <p className="text-[12.5px] leading-relaxed text-soft">{pred.explanation}</p>
          </div>
        )}
        <dl className="mt-4 space-y-2">
          {SENSORS.map((s) => {
            const v = ev[s.key] as number | null;
            return (
              <div key={s.key} className="grid grid-cols-[96px_1fr_104px] items-center gap-3">
                <dt className="mono text-[10.5px] tracking-[0.06em] text-dim uppercase">{s.label}</dt>
                <div className="h-1.5 bg-raised">
                  {v != null && <div className="h-full bg-soft transition-[width] duration-200" style={{ width: `${Math.min(100, (v / ranges[s.key]) * 100)}%` }} />}
                </div>
                <dd className={clsx('mono text-right text-[12px]', v == null ? 'text-alert' : 'text-fg')}>
                  {v == null ? 'no read' : `${fmtNum(v, s.d)}${s.unit}`}
                  {pred.shap?.[s.key] != null && (
                    <span className={clsx('ml-1.5 text-[10px]', pred.shap[s.key] >= 0 ? 'text-good' : 'text-bad')} title="SHAP: push toward (+) or away (−) from the prediction">
                      {pred.shap[s.key] >= 0 ? '+' : ''}
                      {fmtNum(pred.shap[s.key], 2)}
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const blocks = 20;
  const on = Math.round(value * blocks);
  const threshold = Math.round(MANUAL_SORT_BELOW * blocks);
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">Confidence</span>
        <span className="num text-[22px]">{fmtNum(value * 100, 1)}%</span>
      </div>
      <div className="relative mt-2 flex gap-[3px]">
        {Array.from({ length: blocks }, (_, i) => (
          <span key={i} className={clsx('h-3 flex-1 transition-colors duration-200', i < on ? (value >= MANUAL_SORT_BELOW ? 'bg-ghost' : 'bg-alert') : 'bg-raised')} />
        ))}
        <span className="absolute -top-1 -bottom-1 w-px bg-fg/60" style={{ left: `${(threshold / blocks) * 100}%` }} title="Manual-sort threshold" />
      </div>
      <div className="mono mt-1 text-[10px] text-faint">below {MANUAL_SORT_BELOW * 100}% → a person sorts it</div>
    </div>
  );
}

function Feed({ feed }: { feed: Sorted[] }) {
  if (!feed.length) return <Empty sprite="item_plastic" title="No events yet" />;
  return (
    <div className="max-h-[360px] overflow-y-auto pr-1">
      <table className="w-full text-left">
        <thead className="sticky top-0 bg-surface">
          <tr className="mono text-[9.5px] tracking-[0.1em] text-faint uppercase">
            <th className="py-2 font-normal">Time</th>
            <th className="font-normal">Building · bin</th>
            <th className="font-normal">Predicted</th>
            <th className="text-right font-normal">Conf.</th>
            <th className="text-right font-normal">ms</th>
            <th className="pl-4 font-normal">Route</th>
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {feed.slice(0, 14).map(({ ev, pred }) => (
              <motion.tr
                key={ev.event_id}
                layout
                initial={{ opacity: 0, backgroundColor: 'rgba(169,155,255,0.10)' }}
                animate={{ opacity: 1, backgroundColor: 'rgba(169,155,255,0)' }}
                transition={{ duration: 0.6 }}
                className="border-t border-line text-[12.5px]"
              >
                <td className="mono py-2 text-dim">{ev.timestamp.slice(11, 19)}</td>
                <td className="text-soft">
                  {SHORT_NAME[ev.building_id]} <span className="mono text-[10.5px] text-faint">· {ev.bin_id.split('-')[1]}</span>
                </td>
                <td>
                  <span className="inline-flex items-center gap-2">
                    <Sprite name={WASTE_META[pred.label].sprite} size={18} />
                    {WASTE_META[pred.label].label}
                  </span>
                </td>
                <td className={clsx('mono text-right', pred.confidence < MANUAL_SORT_BELOW ? 'text-alert' : 'text-fg')}>{fmtNum(pred.confidence * 100, 0)}%</td>
                <td className="mono text-right text-dim">{fmtNum(pred.time_ms, 2)}</td>
                <td className="pl-4">
                  <span className={clsx('mono text-[10px] tracking-[0.08em] uppercase', pred.route === 'bin' ? 'text-ghost' : 'text-alert')}>
                    {pred.route === 'bin' ? 'bin' : 'manual'}
                  </span>
                </td>
              </motion.tr>
            ))}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="pixel p-3 [--pf:var(--color-bg)] [--px:4px]">
      <div className="eyebrow text-[9.5px]">{label}</div>
      <div className="num mt-2 text-[24px]">{value}</div>
      <div className="mono mt-1 text-[10px] text-dim">{sub}</div>
    </div>
  );
}

function Scorecard({ metrics, className }: { metrics?: ClassifierMetrics; className?: string }) {
  if (!metrics) return <Skeleton className={clsx('h-80', className)} />;
  const pass = metrics.accuracy >= 0.85;
  return (
    <Panel
      className={className}
      title="Model scorecard"
      right={<span className="mono max-w-[22ch] truncate text-[10.5px] text-dim" title={metrics.model_name}>{metrics.model_name ?? 'classifier'}</span>}
    >
      <div className="grid grid-cols-2 gap-2">
        <div className="pixel p-3 [--pf:var(--color-bg)] [--px:4px]">
          <div className="eyebrow text-[9.5px]">Accuracy</div>
          <div className={clsx('num mt-2 text-[30px]', pass ? 'text-good' : 'text-fg')}>{fmtNum(metrics.accuracy * 100, 1)}%</div>
          <div className={clsx('mono mt-1 text-[10px]', pass ? 'text-good' : 'text-alert')}>target 85% · {pass ? 'met' : 'not yet'}</div>
        </div>
        <div className="pixel p-3 [--pf:var(--color-bg)] [--px:4px]">
          <div className="eyebrow text-[9.5px]">Macro F1</div>
          <div className="num mt-2 text-[30px]">{fmtNum(metrics.macro_f1, 3)}</div>
          <div className="mono mt-1 text-[10px] text-dim">
            {fmtNum(metrics.size_kb, 1)} KB · {fmtNum(metrics.time_ms, 2)} ms
          </div>
        </div>
      </div>
      <Confusion m={metrics} />
    </Panel>
  );
}

function Confusion({ m }: { m: ClassifierMetrics }) {
  return (
    <div className="mt-4">
      <div className="eyebrow mb-2 text-[9.5px]">Confusion · rows = true type</div>
      <div className="grid grid-cols-[24px_repeat(6,1fr)] gap-[3px]">
        <span />
        {m.class_names.map((c) => (
          <span key={c} className="grid place-items-center pb-1" title={WASTE_META[c].label}>
            <Sprite name={WASTE_META[c].sprite} size={18} />
          </span>
        ))}
        {m.confusion.map((row, i) => {
          const total = row.reduce((s, v) => s + v, 0) || 1;
          return [
            <span key={`l${i}`} className="grid place-items-center" title={WASTE_META[m.class_names[i]].label}>
              <Sprite name={WASTE_META[m.class_names[i]].sprite} size={18} />
            </span>,
            ...row.map((v, j) => {
              const share = v / total;
              return (
                <span
                  key={`${i}-${j}`}
                  title={`${WASTE_META[m.class_names[i]].label} → ${WASTE_META[m.class_names[j]].label}: ${v}`}
                  className="mono grid aspect-square place-items-center text-[10px]"
                  style={{
                    background: i === j ? `rgba(169,155,255,${0.12 + share * 0.75})` : share > 0 ? `rgba(255,106,77,${0.1 + share * 1.6})` : '#15181b',
                    color: i === j && share > 0.5 ? '#0c0d0f' : '#b4bab3',
                  }}
                >
                  {v || ''}
                </span>
              );
            }),
          ];
        })}
      </div>
    </div>
  );
}
