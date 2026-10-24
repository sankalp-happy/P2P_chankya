import { LIVE_ROUTES, liveApi } from './live';
import { mockApi } from './mock';
import type { Api } from './types';

// auto (default): use the backend for every route it exposes, mock for the rest, and fall back to
// mock per call if the backend is down. mock: never call the backend (VITE_API_MODE=mock).
export const API_MODE: 'auto' | 'mock' = import.meta.env.VITE_API_MODE === 'mock' ? 'mock' : 'auto';

const RETRY_AFTER_MS = 15_000;
let downUntil = 0;

function withFallback<K extends keyof Api>(key: K): Api[K] {
  const live = liveApi[key] as (...a: unknown[]) => Promise<unknown>;
  const mock = mockApi[key] as (...a: unknown[]) => Promise<unknown>;
  return (async (...args: unknown[]) => {
    if (Date.now() < downUntil) return mock(...args);
    try {
      return await live(...args);
    } catch (e) {
      console.warn(`[api] ${String(key)} live call failed, using mock for ${RETRY_AFTER_MS / 1000}s`, e);
      downUntil = Date.now() + RETRY_AFTER_MS;
      return mock(...args);
    }
  }) as Api[K];
}

export const api: Api =
  API_MODE === 'mock'
    ? mockApi
    : ({ ...mockApi, ...Object.fromEntries(LIVE_ROUTES.map((k) => [k, withFallback(k)])) } as Api);

export const LIVE_COUNT = API_MODE === 'mock' ? 0 : LIVE_ROUTES.length;

export type * from './types';
