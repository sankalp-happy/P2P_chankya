// Formatters are cached: toLocaleString() constructs a new Intl.NumberFormat on every call,
// which showed up as a hotspot while the clock is playing.
const nf = new Map<number, Intl.NumberFormat>();
const fmt = (d: number) => {
  let f = nf.get(d);
  if (!f) nf.set(d, (f = new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })));
  return f;
};

export const fmtInt = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '—' : fmt(0).format(Math.round(x)));

export const fmtNum = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '—' : fmt(d).format(x));

export const fmtRs = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '—' : `₹${fmtInt(x)}`);

export const fmtPct = (x: number | null | undefined, d = 1, signed = false) =>
  x == null || !Number.isFinite(x) ? '—' : `${signed && x > 0 ? '+' : ''}${x.toFixed(d)}%`;

/** 12_400 -> "12.4k" for tight spaces */
export const fmtCompact = (x: number | null | undefined) => {
  if (x == null || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(x / 1e3).toFixed(1)}k`;
  return fmtInt(x);
};
