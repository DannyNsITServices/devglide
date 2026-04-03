import type { ProvenanceRecord } from '../types.js';
import { systemClock, type Clock } from './clock.js';

// ── Clock ────────────────────────────────────────────────────────────────────

let clock: Clock = systemClock;

/** Override the clock used by provenance store (for deterministic testing). */
export function _setClockForTest(c: Clock): void { clock = c; }

// ── Storage ──────────────────────────────────────────────────────────────────

// projectId -> (pipeId -> ProvenanceRecord[])
const provenanceStores = new Map<string | null, Map<string, ProvenanceRecord[]>>();

function getProjectStore(projectId: string | null): Map<string, ProvenanceRecord[]> {
  let store = provenanceStores.get(projectId);
  if (!store) {
    store = new Map();
    provenanceStores.set(projectId, store);
  }
  return store;
}

// ── Recording ────────────────────────────────────────────────────────────────

/** Record a provenance event for a pipe. */
export function recordProvenance(
  projectId: string | null,
  record: Omit<ProvenanceRecord, 'ts'>,
): ProvenanceRecord {
  const store = getProjectStore(projectId);
  const full: ProvenanceRecord = { ...record, ts: clock.isoNow() };
  let records = store.get(record.pipeId);
  if (!records) { records = []; store.set(record.pipeId, records); }
  records.push(full);
  return full;
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** Get all provenance records for a pipe, ordered chronologically. */
export function getProvenanceForPipe(pipeId: string, projectId: string | null): ProvenanceRecord[] {
  return getProjectStore(projectId).get(pipeId) ?? [];
}

/** Get all provenance records for a participant across all pipes. */
export function getProvenanceForParticipant(
  actor: string,
  projectId: string | null,
): ProvenanceRecord[] {
  const store = getProjectStore(projectId);
  const result: ProvenanceRecord[] = [];
  for (const records of store.values()) {
    for (const r of records) {
      if (r.actor === actor) result.push(r);
    }
  }
  return result.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Query provenance records with flexible filters. */
export function queryProvenance(
  projectId: string | null,
  filters?: {
    pipeId?: string;
    actor?: string;
    event?: ProvenanceRecord['event'];
    since?: string;
  },
): ProvenanceRecord[] {
  const store = getProjectStore(projectId);
  const result: ProvenanceRecord[] = [];

  for (const [pipeId, records] of store) {
    if (filters?.pipeId && pipeId !== filters.pipeId) continue;
    for (const r of records) {
      if (filters?.actor && r.actor !== filters.actor) continue;
      if (filters?.event && r.event !== filters.event) continue;
      if (filters?.since && r.ts < filters.since) continue;
      result.push(r);
    }
  }

  return result.sort((a, b) => a.ts.localeCompare(b.ts));
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/** Remove provenance records for terminal pipes. */
export function cleanupProvenance(pipeIds: string[], projectId: string | null): void {
  const store = getProjectStore(projectId);
  for (const id of pipeIds) {
    store.delete(id);
  }
}

/** Reset all state (for testing). */
export function _resetForTest(): void {
  provenanceStores.clear();
  clock = systemClock;
}
