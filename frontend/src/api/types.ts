// The frontend <-> backend contract. Field names match the team brief exactly;
// the Python functions of the same name must return these shapes.

import type { Stream, WasteClass } from '../lib/constants';

export type Quality = 'real' | 'filled' | 'missing';

export interface Building {
  building_id: string;
  building_name: string;
  building_type: string;
  floors: number;
  area_sqm: number;
  design_capacity: number;
  has_solar: number;
  solar_capacity_kw: number;
  year_built: number;
  has_composter: number;
}

export interface CalendarDay {
  date: string;
  day_of_week: string;
  day_type: 'working' | 'weekend' | 'holiday' | 'exam' | 'semester_break';
  event: string | null;
  avg_temp_c: number;
  rainfall_mm: number;
  humidity_pct: number;
}

/** load_hourly() */
export interface HourlyRow {
  building_id: string;
  ts: string;
  electricity_kwh: number | null;
  water_litres: number | null;
  solar_kwh: number | null;
  footfall: number | null;
  quality: Quality;
  /** Optional: server ingestion time. Lets the UI show buffered (late) data as offline. */
  received_at?: string | null;
}

/** load_daily(): daily_summary.xlsx columns as they are */
export interface DailyRow {
  date: string;
  building_id: string;
  occupancy_avg: number | null;
  electricity_kwh: number | null;
  water_litres: number | null;
  solar_generation_kwh: number | null;
  wet_organic_kg: number | null;
  dry_recyclable_kg: number | null;
  ewaste_kg: number | null;
  hazardous_kg: number | null;
  composted_kg: number | null;
  recycled_kg: number | null;
  contamination_pct: number | null;
  landfill_kg: number | null;
}

/** load_manual_logs() */
export interface ManualLog {
  ts: string;
  building_id: string;
  stream: 'electricity' | 'water' | 'waste' | 'note';
  value: number | null;
  unit: string | null;
  note: string | null;
  logger_role?: string;
}

/** forecast(building_id, stream, as_of, horizon) */
export interface ForecastPoint {
  ts: string;
  predicted: number;
  low: number;
  high: number;
  is_spike: boolean;
}

/** Optional: forecast_history(building_id, stream, start, end), the faint past ghost line */
export interface HistoryPoint {
  ts: string;
  predicted: number;
}

/** recommend(as_of, top) */
export interface Recommendation {
  rank: number;
  building_id: string;
  cause: string;
  action: string;
  why: string;
  rupees_saved: number;
  co2_kg: number;
  /** Optional extras the UI shows when present */
  stream?: Stream;
  evidence?: string[];
}

/** leaderboard(as_of) */
export interface LeaderboardRow {
  building_id: string;
  expected: number;
  actual: number;
  pct_saved: number;
  credits: number;
  rank: number;
  coverage_pct: number;
  /** Optional extras (proposed): 90% band on `expected`, and demo-simulation flag */
  expected_low?: number;
  expected_high?: number;
  simulated?: boolean;
}

/** simulate_outage(building_id, start_ts, hours) */
export interface Totals {
  electricity_kwh: number;
  water_litres: number;
}
export interface OutageResult {
  buffered: number;
  duplicates_dropped: number;
  gaps_filled: number;
  totals_before: Totals;
  totals_after: Totals;
}

/** outage_table() */
export interface OutageRow {
  building_id: string;
  start: string;
  end: string;
  hours: number;
}

/** forecast_metrics() */
export interface ForecastMethodMetrics {
  method: string;
  error: number;
  size_kb: number;
  time_ms: number;
}

export interface BinEvent {
  event_id: string;
  timestamp: string;
  building_id: string;
  bin_id: string;
  weight_g: number | null;
  moisture_pct: number | null;
  metal_signal: number | null;
  transparency: number | null;
  acoustic_hardness: number | null;
}

/** predict(event) */
export interface Prediction {
  label: WasteClass;
  confidence: number;
  time_ms: number;
  route: 'bin' | 'manual_sort';
}

/** classifier_metrics() */
export interface ClassifierMetrics {
  accuracy: number;
  macro_f1: number;
  confusion: number[][];
  class_names: WasteClass[];
  size_kb: number;
  time_ms: number;
  model_name?: string;
}

export interface Api {
  buildings(): Promise<Building[]>;
  calendar(): Promise<CalendarDay[]>;
  binEvents(): Promise<BinEvent[]>;
  load_hourly(): Promise<HourlyRow[]>;
  load_daily(): Promise<DailyRow[]>;
  load_manual_logs(): Promise<ManualLog[]>;
  forecast(building_id: string, stream: Stream, as_of: string, horizon?: number): Promise<ForecastPoint[]>;
  forecast_history(building_id: string, stream: Stream, start: string, end: string): Promise<HistoryPoint[]>;
  recommend(as_of: string, top?: number): Promise<Recommendation[]>;
  leaderboard(as_of: string): Promise<LeaderboardRow[]>;
  simulate_outage(building_id: string, start_ts: string, hours: number): Promise<OutageResult>;
  outage_table(): Promise<OutageRow[]>;
  forecast_metrics(): Promise<ForecastMethodMetrics[]>;
  predict(event: BinEvent): Promise<Prediction>;
  classifier_metrics(): Promise<ClassifierMetrics>;
}
