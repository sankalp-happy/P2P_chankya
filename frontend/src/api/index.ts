import { liveApi } from './live';
import { mockApi } from './mock';
import type { Api } from './types';

export const API_MODE: 'mock' | 'live' = import.meta.env.VITE_API_MODE === 'live' ? 'live' : 'mock';

export const api: Api = API_MODE === 'live' ? liveApi : mockApi;

export type * from './types';
