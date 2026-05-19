// ── Brainstorm state (chat-local) ─────────────────────────────────────────────
// Thin workflow wrapper over existing merge-all and linear pipes.
// Tracks phase progression and user decisions — does NOT touch pipe reducer/store.

export type BrainstormPhase =
  | 'ideas'          // merge-all child pipe running
  | 'ideas_review'   // waiting for user to accept/retry the idea
  | 'details'        // linear child pipe pass running
  | 'details_review' // waiting for user to accept/adjust/finalize the detail pass
  | 'finalizing'     // final pass running
  | 'complete';      // done

export interface BrainstormRecord {
  id: string;
  assignees: string[];
  prompt: string;
  phase: BrainstormPhase;
  activeChildPipeId: string | null;
  candidateIdea: string | null;
  acceptedIdea: string | null;
  candidateDraft: string | null;
  acceptedDraft: string | null;
  latestUserNote: string | null;
  ideaIterations: number;
  detailIterations: number;
  createdAt: string;
}

// projectId -> (brainstormId -> BrainstormRecord)
const stores = new Map<string | null, Map<string, BrainstormRecord>>();

function getProjectStore(projectId: string | null): Map<string, BrainstormRecord> {
  let store = stores.get(projectId);
  if (!store) {
    store = new Map();
    stores.set(projectId, store);
  }
  return store;
}

export function createBrainstorm(
  id: string,
  assignees: string[],
  prompt: string,
  projectId: string | null,
): BrainstormRecord {
  const store = getProjectStore(projectId);
  const record: BrainstormRecord = {
    id,
    assignees,
    prompt,
    phase: 'ideas',
    activeChildPipeId: null,
    candidateIdea: null,
    acceptedIdea: null,
    candidateDraft: null,
    acceptedDraft: null,
    latestUserNote: null,
    ideaIterations: 0,
    detailIterations: 0,
    createdAt: new Date().toISOString(),
  };
  store.set(id, record);
  return record;
}

export function getBrainstorm(id: string, projectId: string | null): BrainstormRecord | undefined {
  return getProjectStore(projectId).get(id);
}

export function updateBrainstorm(
  id: string,
  projectId: string | null,
  updates: Partial<Pick<BrainstormRecord, 'phase' | 'activeChildPipeId' | 'candidateIdea' | 'acceptedIdea' | 'candidateDraft' | 'acceptedDraft' | 'latestUserNote' | 'ideaIterations' | 'detailIterations'>>,
): BrainstormRecord | undefined {
  const record = getBrainstorm(id, projectId);
  if (!record) return undefined;
  Object.assign(record, updates);
  return record;
}

export function listActiveBrainstorms(projectId: string | null): BrainstormRecord[] {
  const store = getProjectStore(projectId);
  return [...store.values()].filter(r => r.phase !== 'complete');
}

// ── Child pipe → brainstorm mapping ──────────────────────────────────────────
// Tracks which child pipes belong to which brainstorm records.

// "projectId:childPipeId" → brainstormId
const childPipeMap = new Map<string, string>();

function childPipeKey(childPipeId: string, projectId: string | null): string {
  return `${projectId ?? '__none__'}:${childPipeId}`;
}

export function linkChildPipe(brainstormId: string, childPipeId: string, projectId: string | null): void {
  childPipeMap.set(childPipeKey(childPipeId, projectId), brainstormId);
}

export function findBrainstormByChildPipe(childPipeId: string, projectId: string | null): BrainstormRecord | undefined {
  const brainstormId = childPipeMap.get(childPipeKey(childPipeId, projectId));
  if (!brainstormId) return undefined;
  return getBrainstorm(brainstormId, projectId);
}

/** Reset all in-memory state. For testing only. */
export function _resetForTest(): void {
  stores.clear();
  childPipeMap.clear();
}
