import clsx from 'clsx';
import { useClassifierMetrics, useForecastMetrics } from '../api/hooks';
import { PageHeader } from '../components/PageHeader';
import { Panel, Skeleton, Sprite } from '../components/ui';
import { fmtInt, fmtNum } from '../lib/format';

// Proposed per-building bill of materials (INR, retail estimates). Final numbers come from the report.
const BOM = [
  { item: 'Edge gateway (Raspberry Pi 4, 4 GB) + SD + PSU', cost: 6500 },
  { item: '3-phase energy meter with Modbus (CT clamps)', cost: 4200 },
  { item: 'Pulse-output water meter + ESP32 node', cost: 2800 },
  { item: 'Smart-bin sensor kit (load cell, moisture, inductive, optical, piezo)', cost: 3600 },
  { item: 'Turnstile/footfall counter (IR beam pair)', cost: 1400 },
  { item: 'Enclosure, wiring, 4G fallback dongle', cost: 2000 },
];

const SCALE = [
  { n: '3', label: 'Pilot', detail: 'One gateway per building, one small server. Models train centrally once a week and ship to gateways as files under 1 MB.' },
  { n: '8', label: 'Campus today', detail: 'Same design. Gateways only push readings; forecasting and sorting run locally, so server load grows linearly and stays small.' },
  { n: '30+', label: 'Multi-campus', detail: 'Add gateways, not redesign. Ingestion is keyed by (building, timestamp), so duplicates and late bursts reconcile the same way at any scale.' },
];

export default function Models() {
  const { data: fm } = useForecastMetrics();
  const { data: cm } = useClassifierMetrics();
  const best = fm ? Math.min(...fm.map((m) => m.error)) : 0;
  const bom = BOM.reduce((s, b) => s + b.cost, 0);

  return (
    <>
      <PageHeader
        index={7}
        title="Models & AI"
        sub="What we chose for the edge and why: accuracy against size and speed, on hardware a facilities team can afford."
      />
      <div className="grid grid-cols-12 gap-4">
        <Panel className="col-span-12 xl:col-span-7" title="Forecast · 12 h ahead" right={<span className="mono text-[11px] text-dim">error = MAPE, lower is better</span>}>
          {!fm ? (
            <Skeleton className="h-56" />
          ) : (
            <div className="space-y-2">
              {fm.map((m) => (
                <div key={m.method} className={clsx('pixel grid grid-cols-[minmax(200px,1.4fr)_1fr_110px_110px] items-center gap-4 px-3 py-3 [--px:4px]', m.method.startsWith('Our') ? '[--pb:var(--color-ghost)] [--pf:var(--color-raised)]' : '[--pf:var(--color-bg)]')}>
                  <div className="text-[13.5px] font-medium">
                    {m.method}
                    {m.method.startsWith('Our') && <div className="mono mt-0.5 text-[9.5px] tracking-[0.08em] text-ghost uppercase">chosen for the edge</div>}
                  </div>
                  <div>
                    <div className="h-2 bg-raised">
                      <div className={clsx('h-full', m.error === best ? 'bg-ghost' : 'bg-soft')} style={{ width: `${(m.error / 20) * 100}%` }} />
                    </div>
                    <div className="mono mt-1 text-[11px]">{fmtNum(m.error, 1)}% error</div>
                  </div>
                  <div className="text-right">
                    <div className="num text-[18px]">{m.size_kb >= 1000 ? `${fmtNum(m.size_kb / 1000, 0)} MB` : `${fmtNum(m.size_kb, m.size_kb < 1 ? 1 : 0)} KB`}</div>
                    <div className="mono text-[9.5px] text-faint uppercase">model size</div>
                  </div>
                  <div className="text-right">
                    <div className="num text-[18px]">{fmtNum(m.time_ms, m.time_ms < 1 ? 2 : 0)} ms</div>
                    <div className="mono text-[9.5px] text-faint uppercase">per forecast</div>
                  </div>
                </div>
              ))}
              <p className="pt-2 text-[12.5px] leading-relaxed text-soft">
                The foundation model is slightly more accurate but over 1,000× larger and roughly 350× slower on a CPU. A small gradient-boosted model gets within a point of it and runs comfortably on a ₹6,500 gateway, so that's what we ship.
              </p>
            </div>
          )}
        </Panel>

        <Panel className="col-span-12 xl:col-span-5" title="Waste sorter">
          {!cm ? (
            <Skeleton className="h-56" />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {[
                  ['Accuracy', `${fmtNum(cm.accuracy * 100, 1)}%`, cm.accuracy >= 0.85],
                  ['Macro F1', fmtNum(cm.macro_f1, 3), cm.macro_f1 >= 0.85],
                  ['Model size', `${fmtNum(cm.size_kb, 1)} KB`, true],
                  ['Time / item', `${fmtNum(cm.time_ms, 2)} ms`, true],
                ].map(([k, v, ok]) => (
                  <div key={k as string} className="pixel p-3 [--pf:var(--color-bg)] [--px:4px]">
                    <div className="eyebrow text-[9.5px]">{k}</div>
                    <div className={clsx('num mt-2 text-[26px]', ok ? 'text-fg' : 'text-alert')}>{v}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[12.5px] leading-relaxed text-soft">
                Six classes from five cheap sensors. Items under 70% confidence go to a person rather than the wrong bin, which protects recycling contamination more than chasing the last point of accuracy.
              </p>
              <div className="mono mt-2 text-[10.5px] text-faint">{cm.model_name}</div>
            </>
          )}
        </Panel>

        <Panel className="col-span-12 xl:col-span-7" title="Hardware per building" right={<span className="num text-[22px]">₹{fmtInt(bom)}</span>}>
          <table className="w-full text-[13px]">
            <tbody>
              {BOM.map((b) => (
                <tr key={b.item} className="border-t border-line">
                  <td className="py-2.5 text-soft">{b.item}</td>
                  <td className="mono text-right">₹{fmtInt(b.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[12.5px] leading-relaxed text-dim">
            Budget cap ₹25,000 per building. At ₹8/kWh, a building saving 5% of a 6,000 kWh week pays its kit back in about two months.
          </p>
        </Panel>

        <Panel className="col-span-12 xl:col-span-5" title="From 3 buildings to 30+">
          <ol className="space-y-2">
            {SCALE.map((s) => (
              <li key={s.n} className="pixel flex gap-4 p-3 [--pf:var(--color-bg)] [--px:4px]">
                <div className="w-14 shrink-0">
                  <div className="num text-[28px] text-ghost">{s.n}</div>
                  <div className="mono text-[9px] text-faint uppercase">buildings</div>
                </div>
                <div>
                  <div className="text-[13.5px] font-medium">{s.label}</div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-dim">{s.detail}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex items-center gap-3">
            <Sprite name="ghast" size={32} className="animate-bob" />
            <p className="text-[12px] text-dim">Text and figures here are placeholders until the report is final.</p>
          </div>
        </Panel>
      </div>
    </>
  );
}
