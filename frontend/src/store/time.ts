import { create } from 'zustand';
import type { Stream } from '../lib/constants';
import { HOURS, tsToT } from '../lib/time';

export const SPEEDS = [1, 3, 6, 24] as const; // hours advanced per tick
export const TICK_MS = 650;

interface TimeState {
  t: number;
  playing: boolean;
  speed: (typeof SPEEDS)[number];
  building: string;
  stream: Stream;
  chartMode: 'line' | 'candles';
  setT: (t: number) => void;
  step: (dh: number) => void;
  toggle: () => void;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: (typeof SPEEDS)[number]) => void;
  setBuilding: (id: string) => void;
  setStream: (s: Stream) => void;
  setChartMode: (m: 'line' | 'candles') => void;
}

const clamp = (t: number) => Math.max(0, Math.min(HOURS - 1, Math.round(t)));

// Opens the night before mid-sem exams: the library forecast already shows the morning surge.
export const DEFAULT_T = tsToT('2026-09-27 22:00');

export const useTime = create<TimeState>((set, get) => ({
  t: DEFAULT_T,
  playing: false,
  speed: 1,
  building: 'B03',
  stream: 'electricity',
  chartMode: 'line',
  setT: (t) => set({ t: clamp(t) }),
  step: (dh) => set({ t: clamp(get().t + dh) }),
  toggle: () => set((s) => ({ playing: !s.playing && s.t < HOURS - 1 })),
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setBuilding: (building) => set({ building }),
  setStream: (stream) => set({ stream }),
  setChartMode: (chartMode) => set({ chartMode }),
}));
