import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { API_MODE, LIVE_COUNT } from '../api';
import { useDataset } from '../api/hooks';
import type { CalendarDay } from '../api/types';
import { SPEEDS, TICK_MS, useTime } from '../store/time';
import { HOURS, dayIndex, fmtClock, hourOf, tsToT } from '../lib/time';
import DotGrid from './rb/DotGrid';
import { Sprite } from './ui';

export const PAGES = [
  { path: '/', label: 'Campus overview', sprite: 'ghast' },
  { path: '/building', label: 'Building detail', sprite: 'bld_hostel_boys' },
  { path: '/bin', label: 'Smart bin · live', sprite: 'hopper' },
  { path: '/offline', label: 'Offline demo', sprite: 'recycle_chest' },
  { path: '/league', label: 'Ghost league', sprite: 'emerald' },
  { path: '/waste', label: 'Waste & recycling', sprite: 'composter' },
  { path: '/models', label: 'Models & AI', sprite: 'item_ewaste' },
] as const;

export default function Shell({ children }: { children: ReactNode }) {
  usePlayback();
  useKeyboard();
  const playing = useTime((s) => s.playing);
  return (
    <div className="relative flex min-h-full">
      <div className="pointer-events-none fixed inset-0 -z-0 opacity-60">
        <DotGrid dotSize={2.5} gap={24} shape="square" baseColor="#1c2024" activeColor="#a99bff" proximity={110} intro={false} paused={playing} mouseInteraction={!playing} />
      </div>
      <Sidebar />
      <div className="relative z-10 min-w-0 flex-1">
        <TimeBar />
        <main className="mx-auto w-full max-w-[1680px] px-6 pt-5 pb-16">{children}</main>
      </div>
    </div>
  );
}

function usePlayback() {
  const playing = useTime((s) => s.playing);
  const speed = useTime((s) => s.speed);
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const { t, step, setPlaying } = useTime.getState();
      if (t >= HOURS - 1) return setPlaying(false);
      step(speed);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing, speed]);
}

function useKeyboard() {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      const s = useTime.getState();
      if (e.code === 'Space') {
        e.preventDefault();
        s.toggle();
      } else if (e.key === 'ArrowRight') s.step(e.shiftKey ? 24 : 1);
      else if (e.key === 'ArrowLeft') s.step(e.shiftKey ? -24 : -1);
      else if (/^[1-7]$/.test(e.key) && !e.metaKey && !e.ctrlKey) navigate(PAGES[Number(e.key) - 1].path);
      else if (e.key === '[') useSidebar.getState().toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
}

const JUMPS = [
  { label: 'Hackathon', ts: '2026-08-07 20:00' },
  { label: 'Alumni meet', ts: '2026-09-18 23:00' },
  { label: 'Exams', ts: '2026-09-27 22:00' },
  { label: 'Fest', ts: '2026-10-15 22:00' },
];

function TimeBar() {
  const t = useTime((s) => s.t);
  const { data: ix } = useDataset();
  const cal = ix?.calByDay[dayIndex(t)];
  const c = fmtClock(t);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-[68px] max-w-[1680px] items-center gap-6 px-6">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex items-baseline gap-3 whitespace-nowrap tabular-nums" aria-live="polite">
            <span className="num text-[26px] text-dim">{c.dow}</span>
            <span className="num text-[26px]">
              {c.day} {c.mon}
            </span>
            <span className="num text-[26px]">
              {c.hh}
              <span className="animate-pulse-dot">:</span>00
            </span>
          </div>
          {cal && <DayChips cal={cal} />}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <div className="hidden items-center gap-1.5 2xl:flex">
            {JUMPS.map((j) => (
              <button key={j.label} className="chip-btn" onClick={() => useTime.getState().setT(tsToT(j.ts))}>
                {j.label}
              </button>
            ))}
          </div>
          <Transport />
          <span
            className={clsx('chip', API_MODE === 'mock' ? 'text-dim' : 'text-ghost [--pb:var(--color-ghost)]')}
            title={API_MODE === 'mock' ? 'All data from mock fixtures' : 'Live from the team backend (api.py); any route that fails falls back to mock'}
          >
            <span className={clsx('size-1.5', API_MODE === 'mock' ? 'border border-dim' : 'animate-pulse-dot bg-ghost')} />
            {API_MODE === 'mock' ? 'Mock data' : `Live · ${LIVE_COUNT} routes`}
          </span>
        </div>
      </div>
      <Timeline />
    </header>
  );
}

function DayChips({ cal }: { cal: CalendarDay }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className={clsx('chip', cal.day_type === 'exam' && 'text-alert [--pb:var(--color-alert)]')}>{cal.day_type.replace('_', ' ')}</span>
      <span className="chip hidden xl:inline-flex">
        {cal.avg_temp_c.toFixed(1)}°C · {cal.rainfall_mm.toFixed(0)} mm
      </span>
      {cal.event && (
        <span className="mono hidden max-w-[34ch] truncate text-[11px] text-soft lg:inline" title={cal.event}>
          {cal.event}
        </span>
      )}
    </div>
  );
}

function Transport() {
  const playing = useTime((s) => s.playing);
  const speed = useTime((s) => s.speed);
  const { step, toggle, setSpeed } = useTime.getState();
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center">
        <IconBtn label="Back 1 day (Shift+←)" onClick={() => step(-24)}>
          <path d="M11 4 5 10l6 6M17 4l-6 6 6 6" />
        </IconBtn>
        <IconBtn label="Back 1 hour (←)" onClick={() => step(-1)}>
          <path d="M13 4 7 10l6 6" />
        </IconBtn>
        <button
          onClick={toggle}
          aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
          className={clsx(
            'pixel mx-1 grid size-10 place-items-center text-bg [--px:4px]',
            playing ? '[--pf:var(--color-alert)] [--pb:var(--color-alert)]' : '[--pf:var(--color-ghost)] [--pb:var(--color-ghost)] hover:[--pb:#fff]',
          )}
        >
          <svg viewBox="0 0 20 20" className="size-4" fill="currentColor">
            {playing ? <path d="M5 4h3.5v12H5zM11.5 4H15v12h-3.5z" /> : <path d="M6 3.5v13l11-6.5z" />}
          </svg>
        </button>
        <IconBtn label="Forward 1 hour (→)" onClick={() => step(1)}>
          <path d="m7 4 6 6-6 6" />
        </IconBtn>
        <IconBtn label="Forward 1 day (Shift+→)" onClick={() => step(24)}>
          <path d="m3 4 6 6-6 6M9 4l6 6-6 6" />
        </IconBtn>
      </div>
      <div className="seg" role="radiogroup" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button key={s} data-on={speed === s} onClick={() => setSpeed(s)} role="radio" aria-checked={speed === s}>
            {s === 24 ? '1D' : `${s}H`}
          </button>
        ))}
      </div>
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className="grid size-8 place-items-center text-dim transition-colors hover:text-fg">
      <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Full-width 120-day scrubber: exam days in red, weekends darker, event ticks above. */
function Timeline() {
  const t = useTime((s) => s.t);
  const setT = useTime((s) => s.setT);
  const { data: ix } = useDataset();
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const days = ix?.calByDay ?? [];
  const pct = (x: number) => `${(x / (HOURS - 1)) * 100}%`;

  const months = useMemo(
    () =>
      days
        .map((d, i) => ({ i, d }))
        .filter(({ d, i }) => i === 0 || d.date.endsWith('-01'))
        .map(({ d, i }) => ({ i, label: MONTHS[Number(d.date.slice(5, 7)) - 1] })),
    [days],
  );

  const hoverDay = hover != null ? days[dayIndex(hover)] : null;

  // Day cells, event ticks and month labels never change with the clock: build them once so a
  // playback tick doesn't re-render ~250 elements.
  const staticLayer = useMemo(
    () => (
      <>
        {/* day cells */}
          <div className="absolute inset-x-0 top-3 flex h-4 overflow-hidden">
            {days.map((d) => (
              <div
                key={d.date}
                className={clsx(
                  'h-full flex-1 border-r border-bg/70',
                  d.day_type === 'exam'
                    ? 'bg-alert/55'
                    : d.day_type === 'semester_break'
                      ? 'bg-[#15181b]'
                      : d.day_type === 'weekend' || d.day_type === 'holiday'
                        ? 'bg-[#1d2125]'
                        : 'bg-[#2a2f35]',
                )}
              />
            ))}
          </div>
          {/* event ticks */}
          {days.map((d, i) =>
            d.event ? (
              <span key={d.date} className="absolute top-0.5 h-1.5 w-px bg-dim" style={{ left: pct(i * 24 + 12) }} title={d.event} />
            ) : null,
          )}
          {/* months */}
          {months.map((m) => (
            <span key={m.i} className="mono pointer-events-none absolute top-[30px] -translate-x-0 text-[9px] tracking-[0.14em] text-faint" style={{ left: pct(m.i * 24) }}>
              {m.label}
            </span>
          ))}
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [days, months],
  );

  return (
    <div className="mx-auto max-w-[1680px] px-6 pb-3">
      <div
        ref={ref}
        className="relative h-9 select-none"
        onPointerMove={(e) => {
          const r = ref.current!.getBoundingClientRect();
          setHover(Math.round(((e.clientX - r.left) / r.width) * (HOURS - 1)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {staticLayer}
        {/* elapsed overlay */}
        <div className="pointer-events-none absolute top-3 left-0 h-4 bg-ghost/20" style={{ width: pct(t) }} />
        {/* hover ghost head */}
        {hover != null && (
          <>
            <span className="pointer-events-none absolute top-2 h-6 w-px bg-dim" style={{ left: pct(hover) }} />
            <span
              className="pixel mono pointer-events-none absolute -top-5 z-10 -translate-x-1/2 px-2 py-0.5 text-[10px] whitespace-nowrap text-soft [--px:3px] [--pf:var(--color-bg)] [--pb:var(--color-line-strong)]"
              style={{ left: pct(hover) }}
            >
              {fmtClock(hover).day} {fmtClock(hover).mon} {String(hourOf(hover)).padStart(2, '0')}:00
              {hoverDay?.event ? ` · ${hoverDay.event.slice(0, 40)}` : ''}
            </span>
          </>
        )}
        {/* playhead */}
        <span className="pointer-events-none absolute top-1 -ml-px h-7 w-[2px] bg-ghost" style={{ left: pct(t) }}>
          <span className="absolute -top-1 -left-[3px] size-2 bg-ghost" />
        </span>
        <input
          type="range"
          className="scrub absolute inset-0"
          min={0}
          max={HOURS - 1}
          step={1}
          value={t}
          onChange={(e) => setT(Number(e.target.value))}
          aria-label="Time"
          aria-valuetext={`${fmtClock(t).day} ${fmtClock(t).mon} ${fmtClock(t).hh}:00`}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Resizable sidebar: drag the edge, double-click it (or press "[") to collapse to icons.
// ---------------------------------------------------------------------------------

const SIDEBAR_MIN = 72;
const SIDEBAR_MAX = 340;
const SIDEBAR_DEFAULT = 248;
const COLLAPSE_BELOW = 160;
const STORAGE_KEY = 'ghostgrid.sidebar';

function readWidth() {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

const useSidebar = create<{ width: number; lastOpen: number; setWidth: (w: number) => void; toggle: () => void }>((set, get) => ({
  width: readWidth(),
  lastOpen: SIDEBAR_DEFAULT,
  setWidth: (w) => {
    const width = Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w)));
    set({ width, ...(width >= COLLAPSE_BELOW ? { lastOpen: width } : {}) });
    try {
      localStorage.setItem(STORAGE_KEY, String(width));
    } catch {
      /* storage unavailable: width just won't persist */
    }
  },
  toggle: () => {
    const { width, lastOpen, setWidth } = get();
    setWidth(width < COLLAPSE_BELOW ? lastOpen : SIDEBAR_MIN);
  },
}));

function Sidebar() {
  const width = useSidebar((s) => s.width);
  const { setWidth, toggle } = useSidebar.getState();
  const [dragging, setDragging] = useState(false);
  const collapsed = width < COLLAPSE_BELOW;

  return (
    <aside
      style={{ width }}
      className={clsx(
        'sticky top-0 z-50 flex h-screen shrink-0 flex-col border-r border-line bg-bg/90 backdrop-blur-md',
        !dragging && 'transition-[width] duration-200 ease-out',
      )}
      aria-label="Pages"
    >
      <div className={clsx('flex h-[68px] shrink-0 items-center gap-3 border-b border-line', collapsed ? 'justify-center' : 'px-5')}>
        <Sprite name="ghast" size={collapsed ? 30 : 34} className="animate-bob" alt="GhostGrid" />
        {!collapsed && (
          <div className="min-w-0 leading-none">
            <div className="title truncate text-[22px]">GhostGrid</div>
            <div className="eyebrow mt-1 truncate text-[9.5px]">Campus resource grid</div>
          </div>
        )}
      </div>

      <nav className={clsx('flex-1 space-y-1.5 overflow-y-auto py-4', collapsed ? 'px-2.5' : 'px-3')}>
        {!collapsed && <div className="eyebrow px-2 pb-2 text-[9.5px]">Pages</div>}
        {PAGES.map((p, i) => (
          <NavLink
            key={p.path}
            to={p.path}
            end
            title={collapsed ? `${p.label} · ${i + 1}` : undefined}
            className={({ isActive }) =>
              clsx(
                'pixel group flex h-12 items-center gap-3 [--px:4px]',
                collapsed ? 'justify-center' : 'px-2.5',
                isActive
                  ? 'text-fg [--pb:var(--color-ghost)] [--pf:var(--color-raised)]'
                  : 'text-soft [--pb:transparent] [--pf:transparent] hover:text-fg hover:[--pb:var(--color-line-strong)]',
              )
            }
          >
            <Sprite name={p.sprite} size={28} alt="" />
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{p.label}</span>
                <kbd className="chip h-5 px-1.5 text-[9.5px] text-dim">{i + 1}</kbd>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {!collapsed && (
        <div className="mx-3 mb-3 space-y-1.5 border-t border-line px-2 pt-3">
          <div className="eyebrow text-[9.5px]">Shortcuts</div>
          {[
            ['1–7', 'switch page'],
            ['Space', 'play / pause'],
            ['← →', '±1 hour (Shift: day)'],
            ['[', 'collapse sidebar'],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between text-[11.5px] text-dim">
              <span>{v}</span>
              <kbd className="mono text-[10.5px] text-soft">{k}</kbd>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={toggle}
        className={clsx('mono flex h-11 shrink-0 items-center gap-2 border-t border-line text-[10.5px] tracking-[0.1em] text-dim uppercase transition-colors hover:text-fg', collapsed ? 'justify-center' : 'px-5')}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <svg viewBox="0 0 20 20" className={clsx('size-4 transition-transform', collapsed && 'rotate-180')} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 4 6 10l6 6M16 4v12" />
        </svg>
        {!collapsed && 'Collapse'}
      </button>

      {/* drag handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={width}
        aria-label="Resize sidebar"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setWidth(width - 16);
          if (e.key === 'ArrowRight') setWidth(width + 16);
        }}
        onDoubleClick={toggle}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => dragging && setWidth(e.clientX)}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setDragging(false);
          if (useSidebar.getState().width < COLLAPSE_BELOW) setWidth(SIDEBAR_MIN);
        }}
        className={clsx(
          'absolute top-0 -right-[3px] bottom-0 w-[6px] cursor-col-resize transition-colors',
          dragging ? 'bg-ghost/60' : 'hover:bg-ghost/30',
        )}
      />
    </aside>
  );
}
