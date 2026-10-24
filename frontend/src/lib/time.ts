// The whole app runs on an integer hour index `t` from START (0) to HOURS - 1.
// The contract with the backend uses "YYYY-MM-DD HH:MM" strings; these helpers convert.

export const START_MS = Date.UTC(2026, 5, 20, 0, 0); // 20 Jun 2026 00:00
export const HOURS = 120 * 24;
const H = 3_600_000;

const pad = (n: number) => String(n).padStart(2, '0');

// Timestamps are campus-local wall-clock times; we keep them in UTC internally so
// the viewer's own timezone never shifts them.
export function tToDate(t: number) {
  return new Date(START_MS + t * H);
}

export function tToTs(t: number) {
  const d = tToDate(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00`;
}

export function tToDay(t: number) {
  return tToTs(t).slice(0, 10);
}

export function tsToT(ts: string) {
  const [d, time = '00:00'] = ts.split(/[ T]/);
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Math.floor((Date.UTC(y, m - 1, day, hh, mm || 0) - START_MS) / H);
}

/** Fractional hours, for received_at timestamps that are not on the hour. */
export function tsToHours(ts: string) {
  const [d, time = '00:00'] = ts.split(/[ T]/);
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  return (Date.UTC(y, m - 1, day, hh, mm || 0, ss || 0) - START_MS) / H;
}

export function dayIndex(t: number) {
  return Math.floor(t / 24);
}

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function fmtClock(t: number) {
  const d = tToDate(t);
  return {
    dow: DOW[d.getUTCDay()],
    day: pad(d.getUTCDate()),
    mon: MON[d.getUTCMonth()],
    hh: pad(d.getUTCHours()),
  };
}

export function fmtShort(t: number) {
  const c = fmtClock(t);
  return `${c.day} ${c.mon} ${c.hh}:00`;
}

export function fmtDay(day: string) {
  const [, m, d] = day.split('-').map(Number);
  return `${pad(d)} ${MON[m - 1]}`;
}

export function hourOf(t: number) {
  return ((t % 24) + 24) % 24;
}
