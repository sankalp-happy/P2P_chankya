export const fmtInt = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? '—' : Math.round(x).toLocaleString('en-IN');

export const fmtNum = (x: number | null | undefined, d = 1) =>
  x == null || !Number.isFinite(x) ? '—' : x.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

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
