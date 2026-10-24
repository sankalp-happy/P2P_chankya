// Live client: one route per brief function on the FastAPI backend (proxied at /api).
// See frontend/CONTRACT.md for the route list the backend must expose.

import type { Api } from './types';

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
  predict: (event) => post('/predict', event),
  classifier_metrics: () => get('/classifier-metrics'),
};
