import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useDataset, useOutages } from '../api/hooks';
import type { OutageResult, Totals } from '../api/types';
import { BuildingPicker } from '../components/BuildingPicker';
import { PageHeader } from '../components/PageHeader';
import CountUp from '../components/rb/CountUp';
import GlitchText from '../components/rb/GlitchText';
import { Panel, Skeleton, Sprite } from '../components/ui';
import { BUILDING_SPRITE, SHORT_NAME } from '../lib/constants';
import { fmtInt, fmtNum } from '../lib/format';
import { fmtShort, tToTs, tsToT } from '../lib/time';
import { useTime } from '../store/time';

type Phase = 'idle' | 'offline' | 'syncing' | 'synced';
const HOURS_OPTIONS = [3, 6, 12, 24] as const;
const CHANNELS = 4; // electricity, water, solar, footfall per hourly reading

export default function Offline() {
  const t = useTime((s) => s.t);
  const { data: ix } = useDataset();
  const [id, setId] = useState('B05');
  const [hours, setHours] = useState<(typeof HOURS_OPTIONS)[number]>(6);
  const [phase, setPhase] = useState<Phase>('idle');
  const [queued, setQueued] = useState(0);
  const [drained, setDrained] = useState(0);
  const [result, setResult] = useState<(OutageResult & { totals_without_buffer?: Totals }) | null>(null);
  const startT = useRef(t);
  const total = hours * CHANNELS;

  // While offline, readings pile up locally (compressed: one gateway-hour every 250 ms).
  useEffect(() => {
    if (phase !== 'offline') return;
    const id = window.setInterval(() => setQueued((q) => Math.min(total, q + CHANNELS)), 250);
    return () => window.clearInterval(id);
  }, [phase, total]);

  // On reconnect the buffer bursts to the server.
  useEffect(() => {
    if (phase !== 'syncing') return;
    const id = window.setInterval(() => {
      setDrained((d) => {
        const next = Math.min(queued, d + Math.max(2, Math.ceil(queued / 18)));
        if (next >= queued) window.setTimeout(() => setPhase('synced'), 250);
        return next;
      });
    }, 60);
    return () => window.clearInterval(id);
  }, [phase, queued]);

  const takeOffline = () => {
    startT.current = t;
    setQueued(0);
    setDrained(0);
    setResult(null);
    setPhase('offline');
  };
  const reconnect = async () => {
    setPhase('syncing');
    setResult(await api.simulate_outage(id, tToTs(startT.current), hours));
  };
  const reset = () => {
    setPhase('idle');
    setQueued(0);
    setDrained(0);
    setResult(null);
  };

  if (!ix) return <Skeleton className="h-[70vh]" />;
  const dupes = result?.duplicates_dropped ?? Math.round(total * 0.11);

  return (
    <>
      <PageHeader
        index={4}
        title="Offline demo"
        sub="Pull a building's network. Its edge gateway keeps measuring and queues readings locally; on reconnect they arrive in one burst, duplicates are dropped, and campus totals come out exactly the same."
      />
      <div className="grid grid-cols-12 gap-4">
        <Panel className="col-span-12" title="Set up the outage">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <BuildingPicker ids={ix.ids} value={id} onChange={(v) => phase === 'idle' && setId(v)} />
            <div className="flex items-center gap-3">
              <span className="eyebrow">Offline for</span>
              <div className="seg">
                {HOURS_OPTIONS.map((h) => (
                  <button key={h} data-on={hours === h} disabled={phase !== 'idle'} onClick={() => setHours(h)}>
                    {h} h
                  </button>
                ))}
              </div>
              {phase === 'idle' && (
                <button className="btn btn-alert min-w-[150px]" onClick={takeOffline}>
                  Take offline
                </button>
              )}
              {phase === 'offline' && (
                <button className="btn btn-ghost min-w-[150px]" onClick={reconnect} disabled={queued < total}>
                  {queued < total ? 'Buffering…' : 'Reconnect'}
                </button>
              )}
              {(phase === 'syncing' || phase === 'synced') && (
                <button className="btn min-w-[150px]" onClick={reset} disabled={phase === 'syncing'}>
                  Run again
                </button>
              )}
            </div>
          </div>
        </Panel>

        <Panel className="col-span-12 xl:col-span-8" title="Edge gateway → campus server">
          <div className="grid grid-cols-[180px_1fr_180px] items-center gap-6 py-4">
            <div className="flex flex-col items-center gap-3 text-center">
              <Sprite name={BUILDING_SPRITE[id]} size={104} grey={phase === 'offline'} className={phase === 'offline' ? 'animate-shake' : ''} />
              <div className="text-[15px] font-semibold">
                {phase === 'offline' ? <GlitchText color="#ff6a4d" fontSize={15} fontWeight={600} intensity={0.8}>OFFLINE</GlitchText> : SHORT_NAME[id]}
              </div>
              <div className="mono text-[10.5px] text-dim">from {fmtShort(startT.current)}</div>
            </div>

            <div>
              <div className="mb-3 flex items-baseline justify-between">
                <span className="eyebrow">Local buffer</span>
                <span className="mono text-[11px] text-soft">
                  <span className="num text-[22px] text-fg">{phase === 'syncing' || phase === 'synced' ? queued - drained : queued}</span> / {total} readings
                </span>
              </div>
              <QueueGrid total={total} queued={queued} drained={drained} dupes={dupes} phase={phase} />
              <div className="mono mt-3 text-[10.5px] text-faint">
                {phase === 'idle' && 'Each block is one sensor reading: power, water, solar and footfall for one hour.'}
                {phase === 'offline' && 'Network down. The gateway keeps sampling and writes to local flash.'}
                {phase === 'syncing' && 'Link restored. Burst upload, deduplicated by (building, timestamp).'}
                {phase === 'synced' && 'Queue empty. Every reading is accounted for.'}
              </div>
            </div>

            <div className="flex flex-col items-center gap-3 text-center">
              <div className={clsx('pixel grid size-[104px] place-items-center [--px:6px]', phase === 'syncing' && '[--pb:var(--color-ghost)]')}>
                <div className="num text-[28px]">{drained}</div>
              </div>
              <div className="text-[15px] font-semibold">Campus server</div>
              <div className="mono text-[10.5px] text-dim">readings received</div>
            </div>
          </div>
        </Panel>

        <Panel className="col-span-12 xl:col-span-4" title="Reconciliation">
          <div className="grid grid-cols-3 gap-2">
            <Box label="Arrived" value={phase === 'synced' ? result?.buffered ?? 0 : drained} />
            <Box label="Duplicates dropped" value={phase === 'synced' ? dupes : 0} tone="alert" />
            <Box label="Gaps filled" value={phase === 'synced' ? result?.gaps_filled ?? 0 : 0} />
          </div>
          <Totals result={result} show={phase === 'synced'} />
        </Panel>

        <OutageTable className="col-span-12" />
      </div>
    </>
  );
}

function QueueGrid({ total, queued, drained, dupes, phase }: { total: number; queued: number; drained: number; dupes: number; phase: Phase }) {
  // Spread the duplicate retransmissions through the queue deterministically.
  const dupeAt = new Set(Array.from({ length: dupes }, (_, i) => Math.floor(((i + 0.5) * total) / Math.max(1, dupes))));
  return (
    <div className="grid gap-[3px]" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
      {Array.from({ length: total }, (_, i) => {
        const filled = i < queued;
        const gone = (phase === 'syncing' || phase === 'synced') && i < drained;
        const dupe = dupeAt.has(i) && (phase === 'syncing' || phase === 'synced');
        return (
          <span
            key={i}
            className={clsx(
              'aspect-square transition-all duration-300',
              !filled && 'bg-raised',
              filled && !gone && (dupe ? 'bg-alert' : 'bg-ghost/80'),
              gone && 'scale-50 bg-transparent opacity-0',
            )}
          />
        );
      })}
    </div>
  );
}

function Box({ label, value, tone }: { label: string; value: number; tone?: 'alert' }) {
  return (
    <div className="pixel p-3 [--pf:var(--color-bg)] [--px:4px]">
      <div className="eyebrow text-[9px] leading-tight">{label}</div>
      <div className={clsx('num mt-2 text-[26px]', tone === 'alert' && value ? 'text-alert' : '')}>
        <CountUp to={value} duration={0.5} trigger="load" />
      </div>
    </div>
  );
}

function Totals({ result, show }: { result: (OutageResult & { totals_without_buffer?: Totals }) | null; show: boolean }) {
  const rows: { label: string; k: keyof Totals; unit: string }[] = [
    { label: 'Electricity', k: 'electricity_kwh', unit: 'kWh' },
    { label: 'Water', k: 'water_litres', unit: 'L' },
  ];
  const match = result && rows.every((r) => Math.abs(result.totals_before[r.k] - result.totals_after[r.k]) < 0.01);
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">Campus totals for the day</span>
        {show && result && (
          <span className={clsx('chip', match ? 'text-good [--pb:var(--color-good)]' : 'text-alert [--pb:var(--color-alert)]')}>{match ? '✓ Match' : '✕ Mismatch'}</span>
        )}
      </div>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="mono text-[9.5px] tracking-[0.1em] text-faint uppercase">
            <th className="py-1.5 text-left font-normal" />
            <th className="text-right font-normal">Before</th>
            <th className="text-right font-normal">After sync</th>
            <th className="text-right font-normal">No buffer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k} className="border-t border-line">
              <td className="py-2 text-soft">{r.label}</td>
              <td className="mono text-right">{show && result ? `${fmtInt(result.totals_before[r.k])}` : '—'}</td>
              <td className="mono text-right text-good">{show && result ? `${fmtInt(result.totals_after[r.k])}` : '—'}</td>
              <td className="mono text-right text-alert">
                {show && result?.totals_without_buffer ? `${fmtInt(result.totals_without_buffer[r.k])}` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11.5px] leading-relaxed text-dim">“No buffer” is what the dashboard would have shown if the gateway had simply dropped readings while offline.</p>
    </div>
  );
}

function OutageTable({ className }: { className?: string }) {
  const { data } = useOutages();
  const setT = useTime((s) => s.setT);
  const setBuilding = useTime((s) => s.setBuilding);
  return (
    <Panel className={className} title="Real outages found in the data" right={<span className="mono text-[11px] text-dim">{data?.length ?? 0} outages · click to jump there</span>}>
      {!data ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="max-h-[300px] overflow-y-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead className="sticky top-0 bg-surface">
              <tr className="mono text-[9.5px] tracking-[0.1em] text-faint uppercase">
                <th className="py-2 font-normal">Building</th>
                <th className="font-normal">Start</th>
                <th className="font-normal">End</th>
                <th className="text-right font-normal">Hours</th>
                <th className="w-1/3 pl-6 font-normal">Duration</th>
              </tr>
            </thead>
            <tbody>
              {data.map((o) => (
                <tr
                  key={`${o.building_id}${o.start}`}
                  onClick={() => {
                    setBuilding(o.building_id);
                    setT(tsToT(o.start) + Math.min(o.hours - 1, 2));
                  }}
                  className="cursor-pointer border-t border-line transition-colors hover:bg-raised"
                >
                  <td className="py-2">
                    <span className="inline-flex items-center gap-2">
                      <Sprite name={BUILDING_SPRITE[o.building_id]} size={18} />
                      {SHORT_NAME[o.building_id]}
                    </span>
                  </td>
                  <td className="mono text-dim">{fmtShort(tsToT(o.start))}</td>
                  <td className="mono text-dim">{fmtShort(tsToT(o.end))}</td>
                  <td className="mono text-right">{fmtNum(o.hours, 0)}</td>
                  <td className="pl-6">
                    <div className="h-1.5 bg-raised">
                      <div className="h-full bg-alert/80" style={{ width: `${Math.min(100, (o.hours / 12) * 100)}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
