import clsx from 'clsx';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { useLeaderboard } from '../api/hooks';
import type { LeaderboardRow } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import CountUp from '../components/rb/CountUp';
import SplitFlapText from '../components/rb/SplitFlapText';
import { Panel, Skeleton, Sprite } from '../components/ui';
import { BUILDING_SPRITE, CREDIT_SHARE, MIN_COVERAGE, SHORT_NAME } from '../lib/constants';
import { fmtInt, fmtNum, fmtPct } from '../lib/format';
import { HOURS, dayIndex, fmtDay, tToDay } from '../lib/time';
import { useTime } from '../store/time';

// Weeks run Monday to Sunday. 22 Jun 2026 (day 2) is the first full Monday.
const WEEK_STARTS = Array.from({ length: 17 }, (_, i) => 2 + i * 7);
const RANGE = 15; // race bar spans ±15% around the ghost

export default function League() {
  const t = useTime((s) => s.t);
  const current = WEEK_STARTS.findLastIndex((d) => d <= dayIndex(t));
  const [picked, setPicked] = useState<number | null>(null);
  const wi = picked ?? Math.max(0, current);
  const weekStart = WEEK_STARTS[wi];
  const weekEnd = Math.min(HOURS - 1, (weekStart + 7) * 24 - 1);
  const asOf = wi === current ? Math.min(t, weekEnd) : weekEnd;
  const live = wi === current && t < weekEnd;
  const { data: rows } = useLeaderboard(asOf);

  const sorted = useMemo(() => [...(rows ?? [])].sort((a, b) => a.rank - b.rank), [rows]);
  const leader = sorted[0];
  const credits = sorted.reduce((s, r) => s + r.credits, 0);
  const simulated = sorted.some((r) => r.simulated);

  return (
    <>
      <PageHeader
        index={5}
        title="Ghost league"
        sub="Each building races its own ghost: the AI's estimate of what it would normally use given the weather, the calendar and how many people are inside. Only savings beyond the ghost's noise band earn credits."
        right={
          <div className="flex items-center gap-2">
            <button className="btn px-3" onClick={() => setPicked(Math.max(0, wi - 1))} disabled={wi === 0} aria-label="Previous week">
              ←
            </button>
            <div className="pixel min-w-[210px] px-4 py-2 text-center [--px:4px]">
              <div className="eyebrow text-[9.5px]">Week {wi + 1} {live && '· live'}</div>
              <div className="mono mt-0.5 text-[13px]">
                {fmtDay(tToDay(weekStart * 24))} – {fmtDay(tToDay(weekStart * 24 + 144))}
              </div>
            </div>
            <button className="btn px-3" onClick={() => setPicked(Math.min(WEEK_STARTS.length - 1, wi + 1))} disabled={wi === WEEK_STARTS.length - 1} aria-label="Next week">
              →
            </button>
            {picked != null && (
              <button className="chip-btn" onClick={() => setPicked(null)}>
                Follow clock
              </button>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-12 gap-4">
        <Panel className="col-span-12 xl:col-span-8" bodyClassName="pt-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {leader && <Sprite name={BUILDING_SPRITE[leader.building_id]} size={64} className="animate-bob" />}
              <div>
                <div className="eyebrow">Leading this week</div>
                <div className="mt-2">
                  {leader ? (
                    <SplitFlapText
                      key={leader.building_id}
                      text={SHORT_NAME[leader.building_id].toUpperCase()}
                      padTo={12}
                      fontSize={26}
                      tileColor="#1a1d21"
                      textColor="#e8ebe6"
                      tileRadius={2}
                      gap={3}
                      loop={false}
                    />
                  ) : (
                    <Skeleton className="h-10 w-72" />
                  )}
                </div>
              </div>
            </div>
            {leader && (
              <div className="text-right">
                <div className="eyebrow">Beat its ghost by</div>
                <div className={clsx('num mt-2 text-[40px]', leader.pct_saved > 0 ? 'text-good' : 'text-bad')}>{fmtPct(leader.pct_saved, 1, true)}</div>
              </div>
            )}
          </div>
        </Panel>

        <Panel className="col-span-12 xl:col-span-4" title="Building funds · this week">
          <div className="flex items-center gap-4">
            <Sprite name="villager" size={64} />
            <div>
              <div className="flex items-baseline gap-2">
                <Sprite name="emerald" size={22} />
                <span className="num text-[36px]">
                  <CountUp to={credits} duration={0.5} separator="," trigger="load" />
                </span>
              </div>
              <div className="mono mt-1 text-[10.5px] text-dim">credits = ₹1 each · {CREDIT_SHARE * 100}% of verified savings</div>
            </div>
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-soft">
            Each building's fund is spent on what its residents vote for: a common-room upgrade, a mess special, sports kit.
          </p>
        </Panel>

        <Panel
          className="col-span-12 xl:col-span-8"
          title="Standings"
          right={
            simulated && (
              <span className="chip text-dim" title="The dataset has no real campaign, so three buildings carry a labelled demo reduction from 24 Aug.">
                ● SIM = demo campaign effect
              </span>
            )
          }
        >
          {!rows ? <Skeleton className="h-96" /> : <Standings rows={sorted} />}
        </Panel>

        <Panel className="col-span-12 xl:col-span-4" title="How we'll measure if this works">
          <ol className="space-y-3 text-[12.5px] leading-relaxed text-soft">
            <li>
              <span className="text-fg">Fair baseline.</span> The ghost is frozen from data before each week, so a building can't lower its own bar by saving.
            </li>
            <li>
              <span className="text-fg">Control group.</span> Launch credits in 4 buildings, hold 4 back, then swap after 4 weeks. Savings = treated vs control, both against their ghosts.
            </li>
            <li>
              <span className="text-fg">Noise filter.</span> Only savings outside the ghost's 90% band count, so lucky weather never pays.
            </li>
            <li>
              <span className="text-fg">No free points.</span> Below {MIN_COVERAGE * 100}% sensor coverage, a building earns nothing that week. Unplugging a meter can't win.
            </li>
            <li>
              <span className="text-fg">Does it last?</span> Track savings week over week to catch novelty wearing off.
            </li>
          </ol>
        </Panel>
      </div>
    </>
  );
}

function Standings({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <div>
      <div className="mono grid grid-cols-[44px_minmax(150px,1.3fr)_minmax(220px,2fr)_86px_96px_84px] items-center gap-3 px-2 pb-2 text-[9.5px] tracking-[0.1em] text-faint uppercase">
        <span>Pos</span>
        <span>Building</span>
        <span className="flex justify-between">
          <span>◀ saved</span>
          <span>ghost</span>
          <span>over ▶</span>
        </span>
        <span className="text-right">vs ghost</span>
        <span className="text-right">Credits</span>
        <span className="text-right">Coverage</span>
      </div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <motion.li key={r.building_id} layout transition={{ type: 'spring', stiffness: 420, damping: 36 }}>
            <Row r={r} />
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

function Row({ r }: { r: LeaderboardRow }) {
  const lowCoverage = r.coverage_pct < MIN_COVERAGE * 100;
  const band = r.expected_low != null && r.expected ? ((r.expected - r.expected_low) / r.expected) * 100 : 3.5;
  const verified = r.credits > 0;
  const over = r.pct_saved < -band;
  const pos = (x: number) => `${50 + (Math.max(-RANGE, Math.min(RANGE, x)) / RANGE) * 50}%`;
  // pct_saved > 0 means below the ghost, drawn to the left
  const marker = pos(-r.pct_saved);

  return (
    <div className={clsx('pixel grid grid-cols-[44px_minmax(150px,1.3fr)_minmax(220px,2fr)_86px_96px_84px] items-center gap-3 px-2 py-2.5 [--px:4px]', r.rank === 1 ? '[--pb:var(--color-ghost)] [--pf:var(--color-raised)]' : '[--pf:var(--color-bg)]')}>
      <span className={clsx('num text-center text-[26px]', r.rank === 1 ? 'text-ghost' : 'text-soft')}>{r.rank}</span>
      <div className="flex min-w-0 items-center gap-2.5">
        <Sprite name={BUILDING_SPRITE[r.building_id]} size={32} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 truncate text-[13.5px] font-medium">
            {SHORT_NAME[r.building_id]}
            {r.simulated && <span className="mono text-[9px] text-faint">SIM</span>}
          </div>
          <div className="mono text-[10px] text-dim">
            {fmtInt(r.actual)} / {fmtInt(r.expected)} kWh
          </div>
        </div>
      </div>

      <div className="relative h-8">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line-strong" />
        <div className="absolute top-1/2 h-4 -translate-y-1/2 bg-ghost/10" style={{ left: pos(-band), right: `calc(100% - ${pos(band)})` }} title="Noise band: no credits inside" />
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-ghost/60" />
        <Sprite name="ghast" size={16} className="absolute -top-2 left-1/2 -translate-x-1/2 opacity-80" />
        <motion.div className="absolute top-1/2" animate={{ left: marker }} initial={false} transition={{ type: 'spring', stiffness: 160, damping: 20 }} style={{ translateX: '-50%', translateY: '-50%' }}>
          <span className={clsx('block size-3', verified ? 'bg-good' : over ? 'bg-bad' : 'bg-soft')} />
        </motion.div>
      </div>

      <span className={clsx('mono text-right text-[13px]', verified ? 'text-good' : over ? 'text-bad' : 'text-dim')}>
        {fmtPct(r.pct_saved, 1, true)}
        <div className="text-[9px] tracking-[0.06em] uppercase opacity-80">{verified ? 'verified' : over ? 'over' : lowCoverage ? 'no data' : 'in noise'}</div>
      </span>

      <span className="flex items-center justify-end gap-1.5">
        {r.credits > 0 && <Sprite name="emerald" size={16} />}
        <span className={clsx('num text-[18px]', r.credits > 0 ? 'text-fg' : 'text-faint')}>{r.credits > 0 ? fmtInt(r.credits) : '0'}</span>
      </span>

      <div className="text-right">
        <span className={clsx('mono text-[12px]', lowCoverage ? 'text-alert' : 'text-soft')}>{fmtNum(r.coverage_pct, 0)}%</span>
        {lowCoverage && <div className="mono text-[9px] text-alert">sensors down · no credits</div>}
      </div>
    </div>
  );
}
