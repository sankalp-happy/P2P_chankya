import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { api } from '.';
import type { Stream } from '../lib/constants';
import { buildIndex } from '../lib/dataset';
import { HOURS, tToTs } from '../lib/time';

const forever = { staleTime: Infinity, gcTime: Infinity } as const;
// Hour-keyed queries: cached while recent, then garbage-collected so playback doesn't bloat the cache.
const perHour = { staleTime: Infinity, gcTime: 90_000 } as const;

export function useDataset() {
  return useQuery({
    queryKey: ['dataset'],
    queryFn: async () => {
      const [b, c, h, d, l] = await Promise.all([
        api.buildings(),
        api.calendar(),
        api.load_hourly(),
        api.load_daily(),
        api.load_manual_logs(),
      ]);
      return buildIndex(b, c, h, d, l);
    },
    ...forever,
  });
}

// Batched on purpose: one query per (building set, stream, hour) instead of one per building.
// Each resolving query re-renders its subscribers, so per-building queries meant ~30 renders of
// the Overview per playback tick. Batching makes it one render per data group.
export function useForecasts(ids: string[], stream: Stream, t: number, horizon = 12) {
  return useQuery({
    queryKey: ['forecasts', ids.join(), stream, t, horizon],
    queryFn: () => Promise.all(ids.map((id) => api.forecast(id, stream, tToTs(t), horizon))),
    placeholderData: keepPreviousData,
    enabled: ids.length > 0,
    ...perHour,
  });
}

export function useForecast(id: string, stream: Stream, t: number, horizon = 12) {
  const q = useForecasts([id], stream, t, horizon);
  return { ...q, data: q.data?.[0] };
}

export function useHistories(ids: string[], stream: Stream, startT: number, endT: number) {
  return useQuery({
    queryKey: ['histories', ids.join(), stream, startT, endT],
    queryFn: () =>
      Promise.all(ids.map((id) => api.forecast_history(id, stream, tToTs(Math.max(0, startT)), tToTs(Math.min(HOURS - 1, endT))))),
    placeholderData: keepPreviousData,
    retry: false, // optional endpoint: if the backend lacks it, the chart simply omits the ghost line
    enabled: ids.length > 0,
    ...perHour,
  });
}

export function useRecommend(t: number, top = 5) {
  return useQuery({
    queryKey: ['recommend', t, top],
    queryFn: () => api.recommend(tToTs(t), top),
    placeholderData: keepPreviousData,
    ...perHour,
  });
}

export function useLeaderboard(t: number) {
  return useQuery({
    queryKey: ['leaderboard', t],
    queryFn: () => api.leaderboard(tToTs(t)),
    placeholderData: keepPreviousData,
    ...perHour,
  });
}

export const useOutages = () => useQuery({ queryKey: ['outages'], queryFn: api.outage_table, ...forever });
export const useBinEvents = () => useQuery({ queryKey: ['bin-events'], queryFn: api.binEvents, ...forever });
export const useClassifierMetrics = () => useQuery({ queryKey: ['clf-metrics'], queryFn: api.classifier_metrics, ...forever });
export const useForecastMetrics = () => useQuery({ queryKey: ['fc-metrics'], queryFn: api.forecast_metrics, ...forever });
