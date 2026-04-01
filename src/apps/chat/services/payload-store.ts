import { randomUUID, createHash } from 'crypto';
import type { PayloadStatus } from '../types.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** An authoritative payload that holds stage input or output content.
 *  Payloads are stored separately from assignments so they can be fetched
 *  on demand rather than pushed in full via PTY. */
export interface Payload {
  payloadId: string;          // stable UUID — immutable once created
  pipeId: string;
  stageId: string;            // matches the assignment's stageId
  content: string;            // the actual payload content (markdown/text)
  contentHash: string;        // SHA-256 hex digest for integrity verification
  contentVersion: number;     // increments if content is updated (rare — mostly immutable)
  sizeBytes: number;          // byte length of content (UTF-8)
  status: PayloadStatus;

  // Timestamps (ISO 8601)
  createdAt: string;
  updatedAt: string;          // last mutation time (content update or status change)
  archivedAt: string | null;
  deletedAt: string | null;

  // Provenance
  producedBy: string | null;  // participant who produced this content
  sourceStage: number | null; // the stage number that produced this output (for linear input payloads)
}

/** Error codes for payload operations. */
export type PayloadErrorCode =
  | 'PAYLOAD_NOT_FOUND'
  | 'PAYLOAD_DELETED'
  | 'PAYLOAD_TOO_LARGE'
  | 'HASH_MISMATCH';

/** Result of a payload operation. */
export interface PayloadResult {
  ok: boolean;
  error?: string;
  code?: PayloadErrorCode;
  payload?: Payload;
}

// ── Configuration ─────────────────────────────────────────────────────────────

/** Maximum payload size in bytes (default 2 MB). Prevents runaway content from exhausting memory. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

/** Default retention for archived payloads: 24 hours.
 *  Active payloads are never cleaned up — only archived/deleted ones are eligible. */
export const DEFAULT_PAYLOAD_TTL_MS = 24 * 60 * 60 * 1000;

// ── Storage ───────────────────────────────────────────────────────────────────

// projectId -> (payloadId -> Payload)
const stores = new Map<string | null, Map<string, Payload>>();

// projectId -> (pipeId:stageId -> payloadId)  — latest payload per stage
const stageIndex = new Map<string | null, Map<string, string>>();

let clock: Clock = systemClock;
let maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES;

/** Override the clock used for timestamps (for testing). */
export function setClock(c: Clock): void {
  clock = c;
}

/** Override the maximum payload size (for testing). */
export function setMaxPayloadBytes(max: number): void {
  maxPayloadBytes = max;
}

function getProjectStore(projectId: string | null): Map<string, Payload> {
  let store = stores.get(projectId);
  if (!store) { store = new Map(); stores.set(projectId, store); }
  return store;
}

function getStageIndex(projectId: string | null): Map<string, string> {
  let index = stageIndex.get(projectId);
  if (!index) { index = new Map(); stageIndex.set(projectId, index); }
  return index;
}

function stageKey(pipeId: string, stageId: string): string {
  return `${pipeId}:${stageId}`;
}

function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

// ── Payload lifecycle ─────────────────────────────────────────────────────────

/** Create a new payload for a pipe stage.
 *  Content is stored in-memory with a SHA-256 integrity hash.
 *  Returns an error if content exceeds the size limit. */
export function createPayload(
  pipeId: string,
  stageId: string,
  content: string,
  projectId: string | null,
  opts?: { producedBy?: string; sourceStage?: number },
): PayloadResult {
  const size = byteLength(content);
  if (size > maxPayloadBytes) {
    return {
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
      error: `Payload size ${size} bytes exceeds limit of ${maxPayloadBytes} bytes`,
    };
  }

  const now = clock.isoNow();
  const payload: Payload = {
    payloadId: randomUUID(),
    pipeId,
    stageId,
    content,
    contentHash: computeHash(content),
    contentVersion: 1,
    sizeBytes: size,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    producedBy: opts?.producedBy ?? null,
    sourceStage: opts?.sourceStage ?? null,
  };

  const store = getProjectStore(projectId);
  store.set(payload.payloadId, payload);

  // Update stage index
  const sIndex = getStageIndex(projectId);
  sIndex.set(stageKey(pipeId, stageId), payload.payloadId);

  return { ok: true, payload: { ...payload } };
}

/** Get a payload by ID. Returns undefined if not found.
 *  Deleted payloads return undefined — use getPayloadMeta for audit queries. */
export function getPayload(payloadId: string, projectId: string | null): Payload | undefined {
  const payload = getProjectStore(projectId).get(payloadId);
  if (!payload || payload.status === 'deleted') return undefined;
  return payload;
}

/** Get payload metadata without content (for status checks and audit).
 *  Returns the payload even if deleted, but with content redacted. */
export function getPayloadMeta(
  payloadId: string,
  projectId: string | null,
): Omit<Payload, 'content'> & { content: '[redacted]' } | undefined {
  const payload = getProjectStore(projectId).get(payloadId);
  if (!payload) return undefined;
  return { ...payload, content: '[redacted]' };
}

/** Get the latest payload for a specific pipe stage. */
export function getPayloadByStage(
  pipeId: string,
  stageId: string,
  projectId: string | null,
): Payload | undefined {
  const sIndex = getStageIndex(projectId);
  const id = sIndex.get(stageKey(pipeId, stageId));
  if (!id) return undefined;
  return getPayload(id, projectId);
}

/** Fetch payload content with integrity verification.
 *  Returns the content only if the hash matches.
 *  This is the authoritative fetch path — clients call this to get the real payload. */
export function fetchPayloadContent(
  payloadId: string,
  projectId: string | null,
): { ok: true; content: string; contentHash: string; contentVersion: number } | { ok: false; error: string; code: PayloadErrorCode } {
  const payload = getProjectStore(projectId).get(payloadId);
  if (!payload) {
    return { ok: false, code: 'PAYLOAD_NOT_FOUND', error: `Payload ${payloadId} not found` };
  }
  if (payload.status === 'deleted') {
    return { ok: false, code: 'PAYLOAD_DELETED', error: `Payload ${payloadId} has been deleted` };
  }

  // Integrity check — verify hash still matches content
  const currentHash = computeHash(payload.content);
  if (currentHash !== payload.contentHash) {
    return { ok: false, code: 'HASH_MISMATCH', error: `Payload ${payloadId} integrity check failed` };
  }

  return {
    ok: true,
    content: payload.content,
    contentHash: payload.contentHash,
    contentVersion: payload.contentVersion,
  };
}

/** Update the content of a payload (rare — mainly for error correction).
 *  Increments contentVersion and recomputes the hash. */
export function updatePayloadContent(
  payloadId: string,
  newContent: string,
  projectId: string | null,
): PayloadResult {
  const store = getProjectStore(projectId);
  const payload = store.get(payloadId);
  if (!payload) {
    return { ok: false, code: 'PAYLOAD_NOT_FOUND', error: `Payload ${payloadId} not found` };
  }
  if (payload.status === 'deleted') {
    return { ok: false, code: 'PAYLOAD_DELETED', error: `Payload ${payloadId} has been deleted` };
  }

  const size = byteLength(newContent);
  if (size > maxPayloadBytes) {
    return {
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
      error: `Payload size ${size} bytes exceeds limit of ${maxPayloadBytes} bytes`,
    };
  }

  payload.content = newContent;
  payload.contentHash = computeHash(newContent);
  payload.contentVersion++;
  payload.sizeBytes = size;
  payload.updatedAt = clock.isoNow();

  return { ok: true, payload: { ...payload } };
}

// ── Status transitions ────────────────────────────────────────────────────────

/** Archive a payload — marks it as no longer needed but retains content for TTL period.
 *  Typically called when the assignment using this payload reaches a terminal state. */
export function archivePayload(payloadId: string, projectId: string | null): PayloadResult {
  const store = getProjectStore(projectId);
  const payload = store.get(payloadId);
  if (!payload) {
    return { ok: false, code: 'PAYLOAD_NOT_FOUND', error: `Payload ${payloadId} not found` };
  }
  if (payload.status === 'deleted') {
    return { ok: false, code: 'PAYLOAD_DELETED', error: `Payload ${payloadId} already deleted` };
  }

  payload.status = 'archived';
  payload.archivedAt = clock.isoNow();
  payload.updatedAt = payload.archivedAt;

  return { ok: true, payload: { ...payload } };
}

/** Soft-delete a payload — removes content but preserves metadata for audit.
 *  Content is replaced with an empty string and hash is zeroed. */
export function deletePayload(payloadId: string, projectId: string | null): PayloadResult {
  const store = getProjectStore(projectId);
  const payload = store.get(payloadId);
  if (!payload) {
    return { ok: false, code: 'PAYLOAD_NOT_FOUND', error: `Payload ${payloadId} not found` };
  }

  payload.content = '';
  payload.contentHash = computeHash('');
  payload.sizeBytes = 0;
  payload.status = 'deleted';
  payload.deletedAt = clock.isoNow();
  payload.updatedAt = payload.deletedAt;

  return { ok: true, payload: { ...payload } };
}

/** Archive all active payloads for a pipe.
 *  Called when a pipe reaches a terminal state. Returns the count of archived payloads. */
export function archivePipePayloads(pipeId: string, projectId: string | null): number {
  const store = getProjectStore(projectId);
  let count = 0;
  for (const payload of store.values()) {
    if (payload.pipeId === pipeId && payload.status === 'active') {
      payload.status = 'archived';
      payload.archivedAt = clock.isoNow();
      payload.updatedAt = payload.archivedAt;
      count++;
    }
  }
  return count;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

/** Remove archived/deleted payloads older than the given TTL.
 *  Active payloads are never removed — archive them first.
 *  Returns the number of payloads removed from memory. */
export function cleanupExpiredPayloads(
  projectId: string | null,
  ttlMs: number = DEFAULT_PAYLOAD_TTL_MS,
): number {
  const store = getProjectStore(projectId);
  const now = clock.now();
  let removed = 0;

  for (const [id, payload] of store) {
    if (payload.status === 'active') continue;

    const refTs = payload.deletedAt ?? payload.archivedAt ?? payload.updatedAt;
    if (now - new Date(refTs).getTime() >= ttlMs) {
      store.delete(id);

      // Clean up stage index
      const sIndex = getStageIndex(projectId);
      const key = stageKey(payload.pipeId, payload.stageId);
      if (sIndex.get(key) === id) {
        sIndex.delete(key);
      }

      removed++;
    }
  }

  return removed;
}

/** List all payloads for a pipe (active and archived, excluding deleted). */
export function getPayloadsByPipe(pipeId: string, projectId: string | null): Payload[] {
  const store = getProjectStore(projectId);
  const result: Payload[] = [];
  for (const payload of store.values()) {
    if (payload.pipeId === pipeId && payload.status !== 'deleted') {
      result.push(payload);
    }
  }
  return result;
}

/** Get aggregate storage stats for a project. */
export function getStorageStats(projectId: string | null): {
  totalPayloads: number;
  activePayloads: number;
  archivedPayloads: number;
  deletedPayloads: number;
  totalBytes: number;
  activeBytes: number;
} {
  const store = getProjectStore(projectId);
  let total = 0, active = 0, archived = 0, deleted = 0;
  let totalBytes = 0, activeBytes = 0;

  for (const payload of store.values()) {
    total++;
    totalBytes += payload.sizeBytes;
    switch (payload.status) {
      case 'active': active++; activeBytes += payload.sizeBytes; break;
      case 'archived': archived++; break;
      case 'deleted': deleted++; break;
    }
  }

  return { totalPayloads: total, activePayloads: active, archivedPayloads: archived, deletedPayloads: deleted, totalBytes, activeBytes };
}

/** Get all projectIds that have payload data in the store. */
export function getTrackedProjectIds(): Array<string | null> {
  return [...stores.keys()];
}

// ── Recovery ──────────────────────────────────────────────────────────────────

/** Payload recovery event — persisted alongside assignment events. */
export interface PayloadRecoveryEvent {
  type: 'payload-created' | 'payload-updated' | 'payload-archived' | 'payload-deleted';
  payloadId: string;
  pipeId: string;
  stageId: string;
  content?: string;         // only on 'created' and 'updated'
  producedBy?: string;
  sourceStage?: number;
  ts?: string;
}

/** Rehydrate payload state from persisted events.
 *  Called on server restart. Returns payloadIds that are still active. */
export function rehydrateFromEvents(
  events: PayloadRecoveryEvent[],
  projectId: string | null,
): string[] {
  const active: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case 'payload-created': {
        if (event.content === undefined) break;
        const result = createPayload(
          event.pipeId,
          event.stageId,
          event.content,
          projectId,
          { producedBy: event.producedBy, sourceStage: event.sourceStage },
        );
        if (result.ok && result.payload) {
          // Fix the payloadId to match persisted one
          const store = getProjectStore(projectId);
          const generated = result.payload.payloadId;
          if (generated !== event.payloadId) {
            const payload = store.get(generated);
            if (payload) {
              store.delete(generated);
              payload.payloadId = event.payloadId;
              store.set(event.payloadId, payload);
              // Fix stage index
              const sIndex = getStageIndex(projectId);
              const key = stageKey(event.pipeId, event.stageId);
              if (sIndex.get(key) === generated) {
                sIndex.set(key, event.payloadId);
              }
            }
          }
        }
        break;
      }
      case 'payload-updated': {
        if (event.content === undefined) break;
        updatePayloadContent(event.payloadId, event.content, projectId);
        break;
      }
      case 'payload-archived': {
        archivePayload(event.payloadId, projectId);
        break;
      }
      case 'payload-deleted': {
        deletePayload(event.payloadId, projectId);
        break;
      }
    }
  }

  // Collect active payloads
  const store = getProjectStore(projectId);
  for (const payload of store.values()) {
    if (payload.status === 'active') {
      active.push(payload.payloadId);
    }
  }

  return active;
}

// ── Test helper ───────────────────────────────────────────────────────────────

/** Reset all in-memory state. For testing only. */
export function _resetForTest(): void {
  stores.clear();
  stageIndex.clear();
  clock = systemClock;
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES;
}
