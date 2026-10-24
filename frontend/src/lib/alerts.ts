// Alerts are derived in the UI from contract data only (forecast + hourly + manual logs),
// so they keep working unchanged when the live backend replaces the mocks.

import type { ForecastPoint, ManualLog } from '../api/types';
import { BAG_KG, SHORT_NAME, type Stream } from './constants';
import { statusAt, type DataIndex } from './dataset';
import { fmtShort, tsToT } from './time';

export type AlertKind = 'spike' | 'offline' | 'mismatch';

export interface Alert {
  id: string;
  kind: AlertKind;
  building_id: string;
  title: string;
  detail: string;
  at: number; // hour index the alert refers to
  severity: number; // higher = more urgent
}

export function deriveAlerts(
  ix: DataIndex,
  now: number,
  forecasts: Record<Stream, Record<string, ForecastPoint[] | undefined>>,
): Alert[] {
  const out: Alert[] = [];

  for (const id of ix.ids) {
    const st = statusAt(ix.series[id], now);
    if (st.status === 'offline') {
      out.push({
        id: `off-${id}`,
        kind: 'offline',
        building_id: id,
        title: `${SHORT_NAME[id]} offline`,
        detail: `No readings for ${st.staleH} h. The edge gateway is buffering locally and will sync on reconnect.`,
        at: st.lastT,
        severity: 3 + st.staleH / 10,
      });
    }
  }

  (['electricity', 'water'] as Stream[]).forEach((stream) => {
    for (const id of ix.ids) {
      const fc = forecasts[stream][id];
      const spike = fc?.find((p) => p.is_spike);
      if (!spike) continue;
      const peak = fc!.reduce((m, p) => (p.predicted > m.predicted ? p : m), spike);
      const at = tsToT(peak.ts);
      const unit = stream === 'electricity' ? 'kWh' : 'L';
      out.push({
        id: `spike-${stream}-${id}`,
        kind: 'spike',
        building_id: id,
        title: `${stream === 'electricity' ? 'Power' : 'Water'} spike at ${SHORT_NAME[id]}`,
        detail: `Forecast peaks at ${Math.round(peak.predicted).toLocaleString('en-IN')} ${unit}/h around ${fmtShort(at).slice(-5)}, in ${at - now} h.`,
        at,
        severity: 2 + 1 / Math.max(1, at - now),
      });
    }
  });

  for (const m of mismatches(ix, now)) out.push(m);

  return out.sort((a, b) => b.severity - a.severity);
}

function normalise(log: ManualLog): number | null {
  if (log.value == null) return null;
  const u = (log.unit ?? '').toLowerCase();
  if (u === 'kl') return log.value * 1000;
  if (u === 'bags') return log.value * BAG_KG;
  return log.value; // kWh, units (1 unit = 1 kWh), L, kg
}

function mismatches(ix: DataIndex, now: number): Alert[] {
  const out: Alert[] = [];
  for (const log of ix.logs) {
    if (log.stream === 'note') continue;
    const lt = tsToT(log.ts);
    if (lt > now || lt < now - 48) continue;
    const staff = normalise(log);
    if (staff == null) continue;
    const day = log.ts.slice(0, 10);
    let sensor = 0;
    let unit = '';
    if (log.stream === 'waste') {
      const d = ix.dailyBy.get(`${log.building_id}|${day}`);
      if (!d) continue;
      sensor = (d.wet_organic_kg ?? 0) + (d.dry_recyclable_kg ?? 0) + (d.ewaste_kg ?? 0) + (d.hazardous_kg ?? 0);
      unit = 'kg';
    } else {
      const arr = log.stream === 'electricity' ? ix.series[log.building_id].e : ix.series[log.building_id].w;
      const d0 = tsToT(`${day} 00:00`);
      for (let t = d0; t < d0 + 24; t++) if (Number.isFinite(arr[t])) sensor += arr[t];
      unit = log.stream === 'electricity' ? 'kWh' : 'L';
    }
    if (sensor <= 0) continue;
    const diff = (staff - sensor) / sensor;
    if (Math.abs(diff) < 0.25) continue;
    const f = (x: number) => Math.round(x).toLocaleString('en-IN');
    out.push({
      id: `mm-${log.ts}-${log.building_id}-${log.stream}`,
      kind: 'mismatch',
      building_id: log.building_id,
      title: `Staff log ≠ sensors at ${SHORT_NAME[log.building_id]}`,
      detail: `${log.logger_role?.replace('_', ' ') ?? 'Staff'} logged ${f(staff)} ${unit} ${log.stream}; sensors say ${f(sensor)} ${unit} (${diff > 0 ? '+' : ''}${Math.round(diff * 100)}%). Likely a unit or typing slip. Sensor value kept.`,
      at: lt,
      severity: 1 + Math.min(1, Math.abs(diff)),
    });
  }
  return out;
}
