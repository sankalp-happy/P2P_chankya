// Turns the contract's row arrays into dense per-building arrays indexed by hour `t`,
// so "what did campus look like at time t" is O(1) while the time control is playing.

import type { Building, CalendarDay, DailyRow, HourlyRow, ManualLog, Quality } from '../api/types';
import { HOURS, tsToHours, tsToT } from './time';

export type DayGroup = 'work' | 'off' | 'break';

export interface Series {
  e: Float64Array; // electricity kWh, NaN when missing
  w: Float64Array; // water litres
  s: Float64Array; // solar kWh
  f: Float64Array; // footfall
  q: Quality[];
  recv: Float64Array; // received_at in fractional hours since START; NaN when unknown
}

export interface DataIndex {
  buildings: Building[];
  byId: Map<string, Building>;
  ids: string[];
  calendar: CalendarDay[];
  calByDay: CalendarDay[]; // indexed by day number
  dayGroup: DayGroup[];
  series: Record<string, Series>;
  daily: DailyRow[];
  dailyBy: Map<string, DailyRow>; // `${building_id}|${date}`
  logs: ManualLog[];
}

/** Normal ingest lag is ~1h; a reading counts as "arrived" once received_at <= now + this. */
export const ARRIVAL_GRACE_H = 1.25;

export function buildIndex(
  buildings: Building[],
  calendar: CalendarDay[],
  hourly: HourlyRow[],
  daily: DailyRow[],
  logs: ManualLog[],
): DataIndex {
  const ids = buildings.map((b) => b.building_id).sort();
  const series: Record<string, Series> = {};
  for (const id of ids) {
    series[id] = {
      e: new Float64Array(HOURS).fill(NaN),
      w: new Float64Array(HOURS).fill(NaN),
      s: new Float64Array(HOURS).fill(NaN),
      f: new Float64Array(HOURS).fill(NaN),
      q: new Array<Quality>(HOURS).fill('missing'),
      recv: new Float64Array(HOURS).fill(NaN),
    };
  }
  for (const r of hourly) {
    const s = series[r.building_id];
    const t = tsToT(r.ts);
    if (!s || t < 0 || t >= HOURS) continue;
    s.e[t] = r.electricity_kwh ?? NaN;
    s.w[t] = r.water_litres ?? NaN;
    s.s[t] = r.solar_kwh ?? NaN;
    s.f[t] = r.footfall ?? NaN;
    s.q[t] = r.quality;
    s.recv[t] = r.received_at ? tsToHours(r.received_at) : t + 1;
  }
  const calByDay = [...calendar].sort((a, b) => a.date.localeCompare(b.date));
  const dayGroup = calByDay.map<DayGroup>((c) =>
    c.day_type === 'semester_break' ? 'break' : c.day_type === 'weekend' || c.day_type === 'holiday' ? 'off' : 'work',
  );
  const dailyBy = new Map(daily.map((d) => [`${d.building_id}|${d.date}`, d]));
  return {
    buildings,
    byId: new Map(buildings.map((b) => [b.building_id, b])),
    ids,
    calendar: calByDay,
    calByDay,
    dayGroup,
    series,
    daily,
    dailyBy,
    logs: [...logs].sort((a, b) => a.ts.localeCompare(b.ts)),
  };
}

export type LiveStatus = 'live' | 'filled' | 'offline';

/** Has hour t's reading reached the server by wall-clock `now`? */
export function arrived(s: Series, t: number, now: number) {
  return s.q[t] !== 'missing' && s.recv[t] <= now + ARRIVAL_GRACE_H;
}

export function statusAt(s: Series, now: number): { status: LiveStatus; lastT: number; staleH: number } {
  let lastT = now;
  while (lastT >= 0 && !arrived(s, lastT, now)) lastT--;
  const staleH = now - lastT;
  if (staleH >= 2) return { status: 'offline', lastT, staleH };
  if (s.q[now] === 'filled') return { status: 'filled', lastT, staleH };
  return { status: 'live', lastT, staleH };
}

/** Sum of a stream from the start of `now`'s day through `now`, counting only arrived readings. */
export function sumToday(arr: Float64Array, s: Series, now: number) {
  let total = 0;
  for (let t = now - (now % 24); t <= now; t++) if (arrived(s, t, now) && Number.isFinite(arr[t])) total += arr[t];
  return total;
}

export function median(xs: number[]) {
  if (!xs.length) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
