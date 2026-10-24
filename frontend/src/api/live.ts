// Live client for the team backend (repo-root api.py: `uvicorn api:app --port 8000`).
// Its routes already carry the /api prefix; Vite proxies /api/* to :8000 unchanged.
// Every Api function is live; ./index.ts falls back to mock per call if the backend is down.

import type { Api, BinEvent, ClassifierMetrics, Prediction } from './types';

async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const qs = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : '';
  const res = await fetch(`/api${path}${qs}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

// P2's predict(): label, confidence, time_ms, route, plus reason / destination / alert
interface ServerPrediction extends Prediction {
  reason?: string;
  destination?: string;
  alert?: string | null;
}

export const liveApi: Api = {
  buildings: () => get('/buildings'),
  calendar: () => get('/calendar'),
  binEvents: () => get('/bin-events'),
  load_hourly: () => get('/hourly'),
  load_daily: () => get('/daily'),
  load_manual_logs: () => get('/manual-logs'),
  forecast: (building_id, stream, as_of, horizon = 12) => get('/forecast', { building_id, stream, as_of, horizon }),
  forecast_history: (building_id, stream, start, end) => get('/forecast-history', { building_id, stream, start, end }),
  recommend: (as_of, top = 5) => get('/recommend', { as_of, top }),
  leaderboard: (as_of) => get('/leaderboard', { as_of }),
  simulate_outage: (building_id, start_ts, hours) => post('/outage', { building_id, start_ts, hours }),
  outage_table: () => get('/outages'),
  forecast_metrics: () => get('/forecast-metrics'),
  predict: async (event: BinEvent) => {
    const p = await post<ServerPrediction>('/predict', event);
    return { ...p, explanation: p.reason ?? p.explanation, source: 'live' };
  },
  classifier_metrics: async () => {
    const m = await get<ClassifierMetrics & { classes?: ClassifierMetrics['class_names'] }>('/classifier-metrics');
    return { ...m, class_names: m.class_names ?? m.classes ?? [] };
  },
};

export const LIVE_ROUTES = Object.keys(liveApi) as (keyof Api)[];
