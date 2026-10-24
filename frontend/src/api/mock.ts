// Mock implementations of every brief function, running in the browser on the real
// dataset fixtures (public/mock). They are deliberately simple stand-ins: teammates'
// Python functions replace them via VITE_API_MODE=live without any UI change.

import {
  CREDIT_SHARE,
  MANUAL_SORT_BELOW,
  MIN_COVERAGE,
  SHORT_NAME,
  type Stream,
  kwhToCo2,
  kwhToRs,
  waterToKwh,
} from '../lib/constants';
import { buildIndex, median, type DataIndex, type Series } from '../lib/dataset';
import { HOURS, dayIndex, hourOf, tToTs, tsToT } from '../lib/time';
import type {
  Api,
  BinEvent,
  Building,
  CalendarDay,
  ClassifierMetrics,
  DailyRow,
  ForecastPoint,
  HistoryPoint,
  HourlyRow,
  LeaderboardRow,
  ManualLog,
  OutageResult,
  OutageRow,
  Prediction,
  Recommendation,
} from './types';

const cache = new Map<string, Promise<unknown>>();
function fixture<T>(name: string): Promise<T> {
  if (!cache.has(name)) cache.set(name, fetch(`/mock/${name}.json`).then((r) => r.json()));
  return cache.get(name) as Promise<T>;
}

let indexPromise: Promise<DataIndex> | null = null;
function index() {
  indexPromise ??= Promise.all([
    fixture<Building[]>('buildings'),
    fixture<CalendarDay[]>('calendar'),
    fixture<HourlyRow[]>('hourly'),
    fixture<DailyRow[]>('daily'),
    fixture<ManualLog[]>('manual_logs'),
  ]).then((a) => buildIndex(...a));
  return indexPromise;
}

const arr = (s: Series, stream: Stream) => (stream === 'electricity' ? s.e : s.w);

// ---------------------------------------------------------------------------------
// Ghost model: same-hour median over recent days of the same kind, with a
// multiplicative calendar-event factor. Uses only data before `before`.
// ---------------------------------------------------------------------------------

interface DayFlags {
  exam: boolean;
  lib24: boolean;
  hackathon: boolean;
  social: boolean;
  technical: boolean;
}

// Parsed once per dataset: eventFactor sits in the hottest loop, so no string work there.
const dayFlagsCache = new WeakMap<DataIndex, DayFlags[]>();
function dayFlags(ix: DataIndex) {
  let f = dayFlagsCache.get(ix);
  if (!f) {
    f = ix.calByDay.map((c) => {
      const ev = (c.event ?? '').toLowerCase();
      return {
        exam: c.day_type === 'exam',
        lib24: ev.includes('24x7'),
        hackathon: ev.includes('hackathon'),
        social: /alumni|feast|fest|cultural|reception/.test(ev),
        technical: /placement|expo|workshop|lab usage/.test(ev),
      };
    });
    dayFlagsCache.set(ix, f);
  }
  return f;
}

function eventFactor(ix: DataIndex, id: string, stream: Stream, t: number) {
  const d = dayFlags(ix)[dayIndex(t)];
  if (!d) return 1;
  const type = ix.byId.get(id)?.building_type;
  const h = hourOf(t);
  let f = 1;
  if (d.exam) {
    if (type === 'library') f *= h >= 7 ? 1.35 : 1.15;
    else if (type === 'hostel') f *= h >= 20 || h <= 2 ? 1.18 : 1.06;
    else if (type === 'academic') f *= h >= 8 && h <= 17 ? 1.1 : 1;
  }
  if (d.lib24 && type === 'library') f *= 1.25;
  if (d.hackathon) f *= type === 'labs' ? 1.45 : type === 'food' ? 1.3 : 1.05;
  if (d.social && type === 'food' && h >= 10 && h <= 22) f *= stream === 'water' ? 1.35 : 1.5;
  if (d.technical && (type === 'labs' || type === 'academic') && h >= 9 && h <= 18) f *= 1.2;
  return f;
}

function profile(ix: DataIndex, id: string, stream: Stream, t: number, before: number) {
  const a = arr(ix.series[id], stream);
  const group = ix.dayGroup[dayIndex(t)];
  const pick = (strict: boolean) => {
    const xs: number[] = [];
    for (let k = 1; k <= 42 && xs.length < 6; k++) {
      const i = t - 24 * k;
      if (i < 0) break;
      if (i >= before || !Number.isFinite(a[i])) continue;
      if (strict && ix.dayGroup[dayIndex(i)] !== group) continue;
      xs.push(a[i] / eventFactor(ix, id, stream, i));
    }
    return xs;
  };
  let xs = pick(true);
  if (xs.length < 3) xs = pick(false);
  return median(xs) * eventFactor(ix, id, stream, t);
}

/** The ghost for hour t as it would have been predicted 6 h earlier. Shared by every caller. */
function ghostAt(ix: DataIndex, id: string, stream: Stream, t: number) {
  return memoize(`h|${id}|${stream}|${t}`, () => profile(ix, id, stream, t, t - 6));
}

function residualSigma(ix: DataIndex, id: string, stream: Stream, before: number) {
  return memoize(`r|${id}|${stream}|${before}`, () => {
    const a = arr(ix.series[id], stream);
    const r: number[] = [];
    for (let t = Math.max(0, before - 96); t < before; t++) {
      if (!Number.isFinite(a[t])) continue;
      const p = ghostAt(ix, id, stream, t);
      if (Number.isFinite(p)) r.push(a[t] - p);
    }
    if (r.length < 4) return NaN;
    const m = r.reduce((x, y) => x + y, 0) / r.length;
    return Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1));
  });
}

// Bounded cache. It used to clear completely at 4k entries, which a single playback tick
// exceeds, so every tick recomputed thousands of ghosts. Now it evicts the oldest quarter.
const MEMO_MAX = 200_000;
const memo = new Map<string, unknown>();
function memoize<T>(key: string, fn: () => T): T {
  if (memo.has(key)) return memo.get(key) as T;
  if (memo.size >= MEMO_MAX) {
    let drop = MEMO_MAX / 4;
    for (const k of memo.keys()) {
      memo.delete(k);
      if (--drop <= 0) break;
    }
  }
  const v = fn();
  memo.set(key, v);
  return v;
}

/** Yield to the browser before heavy mock work so clicks are handled between computations. */
const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

function forecastSync(ix: DataIndex, id: string, stream: Stream, asOfT: number, horizon: number): ForecastPoint[] {
  return memoize(`f|${id}|${stream}|${asOfT}|${horizon}`, () => {
    const a = arr(ix.series[id], stream);
    const sigma = residualSigma(ix, id, stream, asOfT + 1);
    const recent: number[] = [];
    for (let t = Math.max(0, asOfT - 7 * 24); t <= asOfT; t++) if (Number.isFinite(a[t])) recent.push(a[t]);
    recent.sort((x, y) => x - y);
    const p90 = recent[Math.floor(recent.length * 0.9)] ?? Infinity;
    const out: ForecastPoint[] = [];
    for (let k = 1; k <= horizon; k++) {
      const t = asOfT + k;
      if (t >= HOURS) break;
      const p = profile(ix, id, stream, t, asOfT + 1);
      if (!Number.isFinite(p)) continue;
      const typical = p / eventFactor(ix, id, stream, t);
      const s = Math.max(Number.isFinite(sigma) ? sigma : p * 0.1, p * 0.05);
      const band = 1.28 * s * Math.sqrt(1 + k / 12);
      out.push({
        ts: tToTs(t),
        predicted: round(p, 2),
        low: round(Math.max(0, p - band), 2),
        high: round(p + band, 2),
        is_spike: p > typical * 1.2 && p > p90 * 1.02,
      });
    }
    return out;
  });
}

function historySync(ix: DataIndex, id: string, stream: Stream, startT: number, endT: number): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  for (let t = Math.max(0, startT); t <= Math.min(HOURS - 1, endT); t++) {
    const p = ghostAt(ix, id, stream, t);
    if (Number.isFinite(p)) out.push({ ts: tToTs(t), predicted: round(p, 2) });
  }
  return out;
}

const round = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------------
// recommend(): field notes + ghost residual patterns -> ranked actions
// ---------------------------------------------------------------------------------

const BLOCKS = [
  { from: 0, to: 6, label: '00:00–06:00' },
  { from: 6, to: 12, label: '06:00–12:00' },
  { from: 12, to: 18, label: '12:00–18:00' },
  { from: 18, to: 24, label: '18:00–24:00' },
];

const PATTERN: Record<Stream, { cause: string; action: string }[]> = {
  electricity: [
    { cause: 'Lights, ACs or lab equipment left on overnight', action: 'Run a night sweep and set auto-off timers after 23:00 for idle rooms and equipment.' },
    { cause: 'HVAC starting earlier or harder than headcount needs', action: 'Start HVAC 30 min before first occupancy and zone it by occupied floors.' },
    { cause: 'Afternoon cooling load above what occupancy explains', action: 'Raise AC setpoints to 25 °C and shade sun-facing glazing from 12:00–17:00.' },
    { cause: 'Evening load higher than the headcount explains', action: 'Close and switch off unused floors after 20:00; consolidate evening study spaces.' },
  ],
  water: [
    { cause: 'Night-time flow with nobody using water: probable leak or running pump', action: 'Read the main meter at 02:00 with taps shut; inspect tank overflow and the pump float valve.' },
    { cause: 'Morning wash peak above normal', action: 'Check flush valves for stuck-open cisterns and fit low-flow aerators on washroom taps.' },
    { cause: 'Afternoon draw above normal', action: 'Audit kitchen and cleaning water use; fix running hoses and dripping taps.' },
    { cause: 'Evening draw above normal', action: 'Inspect washrooms and laundry areas for running taps.' },
  ],
};

const NOTE_RULES: { re: RegExp; stream: Stream | null; cause: string; action: string }[] = [
  { re: /leak|wet patch|running fast/i, stream: 'water', cause: 'Water leak reported by staff', action: 'Dispatch the plumber to trace and isolate the leaking line; log the meter before and after the fix.' },
  { re: /left on/i, stream: 'electricity', cause: 'HVAC and lights left on in an unoccupied space', action: 'Add a lights/AC check to the security closing round and put the reading hall AC on a timer.' },
  { re: /inverter|solar/i, stream: 'electricity', cause: 'Rooftop solar inverter fault: grid import is replacing lost solar', action: 'Get the vendor to reset or replace the inverter; alert when solar output drops below 50% of the week before.' },
  { re: /composter/i, stream: null, cause: 'Composter down: wet waste is going to landfill', action: 'Repair the composter motor; route wet waste to the nearest working composter meanwhile.' },
  { re: /meter|analyzer|reading/i, stream: null, cause: 'Meter reading unreliable', action: 'Cross-check against a portable meter and recalibrate before this data counts for credits.' },
  { re: /alumni|expecting|extra cooking/i, stream: 'electricity', cause: 'Large event coming: kitchen surge expected', action: 'Plan batch cooking from RSVP counts and stagger kitchen equipment start-up.' },
];

const SPIKE_ACTION: Record<Stream, Record<string, string>> = {
  electricity: {
    library: 'Pre-cool reading halls from 06:30, hold AC at 25 °C and open floors one at a time as seats fill.',
    hostel: 'Send a 21:00 nudge to residents (“exam night: switch off ACs in empty rooms”) and stagger geyser timers.',
    food: 'Stagger kitchen equipment start-up and batch-cook to headcount instead of running all lines at once.',
    labs: 'Move high-load equipment runs outside the forecast peak and power down idle benches.',
    academic: 'Open only the rooms on the timetable for the peak hours; keep idle floors dark.',
    default: 'Shift flexible loads out of the forecast peak window.',
  },
  water: {
    hostel: 'Pre-fill overhead tanks before the peak and check for stuck flush valves ahead of the morning rush.',
    food: 'Pre-soak and batch dishwashing; check the dishwasher for continuous-fill faults before service.',
    default: 'Pre-fill tanks off-peak and check for running taps ahead of the surge.',
  },
};

function rsFor(stream: Stream, amount: number) {
  const kwh = stream === 'electricity' ? amount : waterToKwh(amount);
  return { rs: kwhToRs(kwh), co2: kwhToCo2(kwh) };
}

function recommendSync(ix: DataIndex, asOfT: number, top: number): Recommendation[] {
  return memoize(`r|${asOfT}|${top}`, () => {
    const cands: (Omit<Recommendation, 'rank'> & { score: number })[] = [];
    const win = 72;
    const from = Math.max(0, asOfT - win + 1);

    // 1) field notes from the last 3 days
    for (const log of ix.logs) {
      if (log.stream !== 'note' || !log.note) continue;
      const lt = tsToT(log.ts);
      if (lt > asOfT || lt < asOfT - win) continue;
      const rule = NOTE_RULES.find((r) => r.re.test(log.note!));
      if (!rule || /fixed|replaced|reset by vendor|working again|generating again/i.test(log.note)) continue;
      const name = SHORT_NAME[log.building_id];
      let rs = 0;
      let co2 = 0;
      let measured = '';
      if (rule.stream) {
        const { excess, unit } = excessOver(ix, log.building_id, rule.stream, from, asOfT);
        const week = (excess / Math.max(1, asOfT - from + 1)) * 24 * 7;
        ({ rs, co2 } = rsFor(rule.stream, Math.max(0, week)));
        if (excess > 0) measured = ` Sensors agree: ${fmt(excess)} ${unit} above its ghost in the last ${asOfT - from + 1} h.`;
      }
      cands.push({
        building_id: log.building_id,
        cause: rule.cause,
        action: rule.action,
        why: `${log.logger_role?.replace('_', ' ') ?? 'Staff'} logged at ${name} on ${log.ts.slice(5, 16)}: “${log.note}”.${measured}`,
        rupees_saved: round(rs),
        co2_kg: round(co2, 1),
        stream: rule.stream ?? undefined,
        evidence: [`Field log · ${log.ts}`, ...(measured ? ['Telemetry above ghost band'] : [])],
        score: 2 + rs / 500,
      });
    }

    // 2) recurring time-of-day patterns above the ghost
    for (const id of ix.ids) {
      for (const stream of ['electricity', 'water'] as Stream[]) {
        const a = arr(ix.series[id], stream);
        BLOCKS.forEach((blk, bi) => {
          let exp = 0;
          let act = 0;
          const daysOver = new Set<number>();
          const perDay = new Map<number, [number, number]>();
          for (let t = Math.max(0, asOfT - 167); t <= asOfT; t++) {
            const h = hourOf(t);
            if (h < blk.from || h >= blk.to || !Number.isFinite(a[t])) continue;
            const p = ghostAt(ix, id, stream, t);
            if (!Number.isFinite(p)) continue;
            exp += p;
            act += a[t];
            const d = dayIndex(t);
            const cur = perDay.get(d) ?? [0, 0];
            perDay.set(d, [cur[0] + p, cur[1] + a[t]]);
          }
          perDay.forEach(([e, x], d) => x > e * 1.1 && daysOver.add(d));
          const excess = act - exp;
          const minAbs = stream === 'electricity' ? 8 : 600;
          if (exp <= 0 || excess < minAbs || excess / exp < 0.08 || daysOver.size < 2) return;
          const week = (excess / Math.max(1, perDay.size)) * 7;
          const { rs, co2 } = rsFor(stream, week);
          const unit = stream === 'electricity' ? 'kWh' : 'L';
          const name = SHORT_NAME[id];
          const pat = PATTERN[stream][bi];
          cands.push({
            building_id: id,
            cause: pat.cause,
            action: pat.action,
            why: `${name}'s ${stream} between ${blk.label} ran ${round((excess / exp) * 100)}% above its ghost on ${daysOver.size} of the last ${perDay.size} days (${fmt(act)} vs ${fmt(exp)} ${unit}). The pattern repeats at the same hours, so it's behaviour or equipment, not a one-off event.`,
            rupees_saved: round(rs),
            co2_kg: round(co2, 1),
            stream,
            evidence: [`${daysOver.size}/${perDay.size} days above ghost`, `Window ${blk.label}`],
            score: 1 + rs / 500,
          });
        });
      }
    }

    // 3) forecast spikes in the next 12 h: act before they happen
    for (const id of ix.ids) {
      for (const stream of ['electricity', 'water'] as Stream[]) {
        const fc = forecastSync(ix, id, stream, asOfT, 12);
        const spikes = fc.filter((p) => p.is_spike);
        if (!spikes.length) continue;
        const peak = spikes.reduce((m, p) => (p.predicted > m.predicted ? p : m));
        const pt = tsToT(peak.ts);
        const surge = spikes.reduce((s, p) => s + (p.predicted - p.predicted / eventFactor(ix, id, stream, tsToT(p.ts))), 0);
        const { rs, co2 } = rsFor(stream, surge * 0.15);
        const cal = ix.calByDay[dayIndex(pt)];
        const driver = cal?.day_type === 'exam' ? 'exam day' : cal?.event ? cal.event : 'the usual peak';
        const type = ix.byId.get(id)?.building_type ?? '';
        const unit = stream === 'electricity' ? 'kWh' : 'L';
        cands.push({
          building_id: id,
          cause: `${stream === 'electricity' ? 'Power' : 'Water'} surge forecast at ${tToTs(pt).slice(11)} (${driver})`,
          action: SPIKE_ACTION[stream][type] ?? SPIKE_ACTION[stream].default,
          why: `The forecast puts ${SHORT_NAME[id]} at ${fmt(peak.predicted)} ${unit}/h around ${tToTs(pt).slice(11)}, in ${pt - asOfT} h, about ${round((surge / Math.max(1, spikes.reduce((s, p) => s + p.predicted, 0) - surge)) * 100)}% above a normal day at those hours. Acting before the surge trims an estimated 15% of the extra load.`,
          rupees_saved: round(rs),
          co2_kg: round(co2, 1),
          stream,
          evidence: [`Forecast peak ${fmt(peak.predicted)} ${unit}/h`, `Driver: ${driver.slice(0, 40)}`],
          score: 0.8 + rs / 500,
        });
      }
    }

    // 4) standing opportunity: night base load that stays high while the building is empty
    for (const id of ix.ids) {
      const a = ix.series[id].e;
      let night = 0;
      let nN = 0;
      let day = 0;
      let nD = 0;
      for (let t = Math.max(0, asOfT - 167); t <= asOfT; t++) {
        if (!Number.isFinite(a[t])) continue;
        const h = hourOf(t);
        if (h >= 1 && h <= 4) (night += a[t]), nN++;
        else if (h >= 10 && h <= 16) (day += a[t]), nD++;
      }
      if (!nN || !nD) continue;
      const ratio = night / nN / (day / nD);
      const type = ix.byId.get(id)?.building_type;
      if (ratio < 0.3 || type === 'hostel') continue; // hostels are occupied at night by design
      const target = 0.2 * (day / nD);
      const weekly = Math.max(0, night / nN - target) * 7 * 7; // ~7 empty hours a night
      const { rs, co2 } = rsFor('electricity', weekly * 0.5);
      cands.push({
        building_id: id,
        cause: 'High base load while the building is empty',
        action: 'Find always-on loads with a 02:00 walk-through; put corridor lights, AHUs and idle PCs on schedules.',
        why: `Between 01:00 and 05:00 ${SHORT_NAME[id]} still draws ${round(ratio * 100)}% of its daytime load (${fmt(night / nN)} vs ${fmt(day / nD)} kWh/h) over the last week. Empty ${type} buildings usually idle at around 20%.`,
        rupees_saved: round(rs),
        co2_kg: round(co2, 1),
        stream: 'electricity',
        evidence: [`Night/day ratio ${round(ratio * 100)}%`, 'Last 7 days'],
        score: 0.5 + rs / 500,
      });
    }

    // keep the strongest item per building+cause, then rank
    const seen = new Set<string>();
    return cands
      .sort((x, y) => y.score - x.score)
      .filter((c) => {
        const k = `${c.building_id}|${c.cause}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, top)
      .map(({ score: _s, ...c }, i) => ({ ...c, rank: i + 1 }));
  });
}

function excessOver(ix: DataIndex, id: string, stream: Stream, from: number, to: number) {
  const a = arr(ix.series[id], stream);
  let excess = 0;
  for (let t = from; t <= to; t++) {
    if (!Number.isFinite(a[t])) continue;
    const p = ghostAt(ix, id, stream, t);
    if (Number.isFinite(p)) excess += a[t] - p;
  }
  return { excess, unit: stream === 'electricity' ? 'kWh' : 'L' };
}

const fmt = (x: number) => Math.round(x).toLocaleString('en-IN');

// ---------------------------------------------------------------------------------
// leaderboard(): week containing as_of, frozen ghost from data before the week.
// Demo campaign: three buildings get a simulated reduction from 24 Aug (flagged).
// ---------------------------------------------------------------------------------

const CAMPAIGN_T = tsToT('2026-08-24 00:00');
const SIM_FACTOR: Record<string, number> = { B05: 0.9, B06: 0.93, B03: 0.95 };

function leaderboardSync(ix: DataIndex, asOfT: number): LeaderboardRow[] {
  return memoize(`l|${asOfT}`, () => {
    const day = dayIndex(asOfT);
    const dow = (new Date(Date.UTC(2026, 5, 20 + day)).getUTCDay() + 6) % 7; // Mon = 0
    const weekStart = (day - dow) * 24;
    const end = Math.min(asOfT, weekStart + 167);
    const rows = ix.ids.map((id) => {
      const a = ix.series[id].e;
      const q = ix.series[id].q;
      let exp = 0;
      let act = 0;
      let covered = 0;
      let total = 0;
      for (let t = Math.max(0, weekStart); t <= end; t++) {
        total++;
        if (q[t] === 'missing' || !Number.isFinite(a[t])) continue;
        covered++;
        const p = profile(ix, id, 'electricity', t, weekStart);
        if (!Number.isFinite(p)) continue;
        exp += p;
        act += a[t] * (t >= CAMPAIGN_T ? (SIM_FACTOR[id] ?? 1) : 1);
      }
      const coverage = total ? covered / total : 0;
      const band = exp * 0.035;
      const saved = exp - act;
      const verified = coverage >= MIN_COVERAGE && act < exp - band;
      return {
        building_id: id,
        expected: round(exp, 1),
        actual: round(act, 1),
        pct_saved: exp ? round((saved / exp) * 100, 1) : 0,
        credits: verified ? round(kwhToRs(saved) * CREDIT_SHARE) : 0,
        rank: 0,
        coverage_pct: round(coverage * 100, 1),
        expected_low: round(exp - band, 1),
        expected_high: round(exp + band, 1),
        simulated: id in SIM_FACTOR && end >= CAMPAIGN_T,
      };
    });
    rows.sort((x, y) => y.pct_saved - x.pct_saved).forEach((r, i) => (r.rank = i + 1));
    return rows;
  });
}

// ---------------------------------------------------------------------------------
// Edge buffer: outage replay + real outages found in the data
// ---------------------------------------------------------------------------------

function campusTotals(ix: DataIndex, day: number, skip?: { id: string; from: number; to: number }) {
  let e = 0;
  let w = 0;
  for (const id of ix.ids) {
    const s = ix.series[id];
    for (let t = day * 24; t < day * 24 + 24; t++) {
      if (skip && id === skip.id && t >= skip.from && t < skip.to) continue;
      if (Number.isFinite(s.e[t])) e += s.e[t];
      if (Number.isFinite(s.w[t])) w += s.w[t];
    }
  }
  return { electricity_kwh: round(e, 1), water_litres: round(w) };
}

function simulateOutageSync(ix: DataIndex, id: string, startT: number, hours: number): OutageResult & { totals_without_buffer: OutageResult['totals_before'] } {
  const s = ix.series[id];
  const endT = Math.min(HOURS, startT + hours);
  let gaps = 0;
  for (let t = startT; t < endT; t++) if (s.q[t] !== 'real') gaps++;
  const channels = 4;
  const day = dayIndex(startT);
  const before = campusTotals(ix, day);
  return {
    buffered: (endT - startT) * channels,
    duplicates_dropped: Math.max(1, Math.round((endT - startT) * channels * 0.11)),
    gaps_filled: gaps,
    totals_before: before,
    totals_after: { ...before },
    totals_without_buffer: campusTotals(ix, day, { id, from: startT, to: endT }),
  };
}

function outageTableSync(ix: DataIndex): OutageRow[] {
  return memoize('outages', () => {
    const rows: OutageRow[] = [];
    for (const id of ix.ids) {
      const s = ix.series[id];
      let runStart = -1;
      for (let t = 0; t <= HOURS; t++) {
        const down = t < HOURS && (s.q[t] === 'missing' || s.recv[t] - t > 2.5);
        if (down && runStart < 0) runStart = t;
        if (!down && runStart >= 0) {
          if (t - runStart >= 2) rows.push({ building_id: id, start: tToTs(runStart), end: tToTs(t), hours: t - runStart });
          runStart = -1;
        }
      }
    }
    return rows.sort((a, b) => a.start.localeCompare(b.start));
  });
}

// ---------------------------------------------------------------------------------
// Classifier: Gaussian naive Bayes exported by scripts/build_fixtures.py
// ---------------------------------------------------------------------------------

interface NBModel {
  classes: Prediction['label'][];
  features: (keyof BinEvent)[];
  priors: number[];
  mean: number[][];
  var: number[][];
}

function nbPredict(m: NBModel, ev: BinEvent): Prediction {
  const t0 = performance.now();
  const logp = m.classes.map((_, i) => {
    let lp = Math.log(m.priors[i]);
    m.features.forEach((f, j) => {
      const v = ev[f] as number | null;
      if (v == null || !Number.isFinite(v)) return;
      const mu = m.mean[i][j];
      const va = m.var[i][j];
      lp += -0.5 * Math.log(2 * Math.PI * va) - (v - mu) ** 2 / (2 * va);
    });
    return lp;
  });
  const mx = Math.max(...logp);
  const ps = logp.map((x) => Math.exp(x - mx));
  const z = ps.reduce((x, y) => x + y, 0);
  let best = 0;
  ps.forEach((p, i) => p > ps[best] && (best = i));
  const confidence = ps[best] / z;
  return {
    label: m.classes[best],
    confidence: round(confidence, 3),
    time_ms: round(performance.now() - t0, 3),
    route: confidence >= MANUAL_SORT_BELOW ? 'bin' : 'manual_sort',
  };
}

// ---------------------------------------------------------------------------------

export const mockApi: Api = {
  buildings: () => fixture('buildings'),
  calendar: () => fixture('calendar'),
  binEvents: () => fixture('bin_events'),
  load_hourly: () => fixture('hourly'),
  load_daily: () => fixture('daily'),
  load_manual_logs: () => fixture('manual_logs'),
  forecast: async (id, stream, asOf, horizon = 12) => {
    const ix = await index();
    await nextTask();
    return forecastSync(ix, id, stream, tsToT(asOf), horizon);
  },
  forecast_history: async (id, stream, start, end) => {
    const ix = await index();
    await nextTask();
    return historySync(ix, id, stream, tsToT(start), tsToT(end));
  },
  recommend: async (asOf, top = 5) => {
    const ix = await index();
    await nextTask();
    return recommendSync(ix, tsToT(asOf), top);
  },
  leaderboard: async (asOf) => {
    const ix = await index();
    await nextTask();
    return leaderboardSync(ix, tsToT(asOf));
  },
  simulate_outage: async (id, start, hours) => simulateOutageSync(await index(), id, tsToT(start), hours),
  outage_table: async () => outageTableSync(await index()),
  forecast_metrics: async () => [
    { method: 'Simple guess (same hour last week)', error: 14.6, size_kb: 0.1, time_ms: 0.01 },
    { method: 'Our model (LightGBM)', error: 7.9, size_kb: 420, time_ms: 2.4 },
    { method: 'Chronos-2 (foundation model)', error: 7.1, size_kb: 478_000, time_ms: 860 },
  ],
  predict: async (ev) => nbPredict(await fixture<NBModel>('classifier_model'), ev),
  classifier_metrics: () => fixture<ClassifierMetrics>('classifier_metrics'),
};

