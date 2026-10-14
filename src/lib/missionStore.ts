import { create } from 'zustand';

export type MissionStatus = 'draft' | 'planned' | 'running' | 'review' | 'done' | 'failed';

export interface Mission {
  id: string;
  goal: string;
  sessionId: string | null;
  status: MissionStatus;
  createdAt: string;
}

export interface MissionEvent {
  at: number;
  kind: string;
  text: string;
  taskId?: string;
}

interface MissionStore {
  missions: Mission[];
  activeId: string | null;
  events: Record<string, MissionEvent[]>;
  setActive(id: string | null): void;
  upsertMission(m: Mission): void;
  setStatus(id: string, status: MissionStatus): void;
  addEvent(id: string, e: MissionEvent): void;
  clear(): void;
}

export const useMissionStore = create<MissionStore>((set) => ({
  missions: [],
  activeId: null,
  events: {},
  setActive: (id) => set({ activeId: id }),
  upsertMission: (m) => set((s) => ({ missions: [...s.missions.filter((x) => x.id !== m.id), m] })),
  setStatus: (id, status) =>
    set((s) => ({ missions: s.missions.map((m) => (m.id === id ? { ...m, status } : m)) })),
  addEvent: (id, e) => set((s) => ({ events: { ...s.events, [id]: [...(s.events[id] ?? []), e] } })),
  clear: () => set({ missions: [], activeId: null, events: {} }),
}));
