# Pipe Upgrade Migration Strategy

## Overview

This document defines the rollout strategy for migrating pipe delivery from
**one-shot pushed payloads** (full stage input PTY-injected directly) to
**assignment-based pull delivery** (compact notification envelope via PTY,
authoritative payload fetched by the assignee).

## Current State (Push Model)

### Delivery flow

1. `handlePipeCommand()` creates pipe in `pipe-store`, emits `start` event.
2. `runPipeReducer()` calls `computeNextActions(state)` which returns `PipeAction[]`.
3. For each action:
   - `grantLease(pipeId, assignee, projectId)` — one lease per participant.
   - `startStageDeadline()` — sets timeout timer.
   - `markEmitted()` — idempotency tracking.
   - Constructs a **full delivery message** containing the complete prompt,
     previous-stage output reference, and submit instructions.
   - PTY-injects the full message to the target assignee via `deliverToPty()`.
4. Assignee calls `pipe_submit(pipeId, content)` which validates lease ownership.
5. Reducer re-runs, next action emitted.

### Key surfaces

| Surface | Current behavior |
|---------|-----------------|
| PTY delivery | Full payload embedded in `[DevGlide Chat] @system: ...` message |
| `pipe_submit(pipeId, content)` | Submit by pipeId, lease validated |
| `pipe_read_output(pipeId)` | Read previous stage output (scoped to caller's role) |
| `chat_send` rejection | Messages starting with `#pipe-` are rejected; must use `pipe_submit` |

### Data structures

- `StoredPipe`: slots, emission tracking sets, timeout config
- `PipeSlot`: `{assignee, role, stage, status, content, submittedAt}`
- `LeaseInfo`: `{pipeId, assignee, slotRole, stage, grantedAt, deadline}`
- `PipeRecoveryEvent`: persisted to `{pipeId}.events.jsonl` for server restart recovery

## Target State (Assignment-Based Pull Model)

### Delivery flow

1. Pipe creation unchanged.
2. Reducer computes next actions (pure: `reduce(state, event) -> [nextState, effects]`).
3. For each action:
   - Create a durable **Assignment** record (`assignmentId`, lifecycle states).
   - Store the authoritative **payload** server-side (with integrity hash).
   - PTY-inject a **compact notification envelope**: `{assignmentId, pipeId, stageId, role}`.
   - Start ack/fetch tracking timer.
4. Assignee receives notification -> calls `pipe_get_assignment(assignmentId)` to fetch payload.
5. Server records `payload_fetched` state.
6. Assignee calls `pipe_submit(assignmentId, content)` (now bound to assignmentId).
7. Assignment lifecycle: `assigned -> notified -> acknowledged -> payload_fetched -> submitted`.

### New surfaces

| Surface | New behavior |
|---------|-------------|
| PTY delivery | Compact envelope only (assignmentId, pipeId, stageId, role, ~100 chars) |
| `pipe_get_assignment(assignmentId)` | Fetch authoritative payload, records `payload_fetched` |
| `pipe_list_assignments()` | List pending assignments (for reconnect recovery) |
| `pipe_submit(assignmentId, content)` | Submit by assignmentId (backward compat: pipeId still accepted) |
| `pipe_read_output(pipeId)` | Unchanged (previous stage output, scoped read) |
| Ack/fetch tracking | Re-notify if no fetch within window; dead-letter after exhaustion |

## Migration Phases

### Phase 0: Foundation (no behavioral change)

**Goal:** Lay groundwork without changing any observable behavior.

**Changes:**
- Extract pure reducer: `reduce(state, event) -> [nextState, effects]` (task `wj6zegpb`)
- Inject clock into lease/timeout logic (task `luz7zthq`)
- Define Assignment model types (task `zk8933rf`)
- Define payload storage types and lifecycle (task `hptc4cky`)

**Verification:**
- All existing tests pass.
- No change to PTY delivery format.
- No new MCP tools exposed yet.

### Phase 1: Server-side assignment infrastructure (invisible to clients)

**Goal:** Wire assignment + payload stores into the pipe lifecycle without
changing any observable delivery behavior.

**Note:** `assignment-store.ts`, `payload-store.ts`, and `pipe-delivery.ts`
already exist on this branch with in-memory stores, injectable clocks, and
the `pipe_list_assignments` / `pipe_get_assignment` MCP tools already
registered. Phase 1 is about completing the wiring into `createPipe()` and
`runPipeReducer()`, not adding new files or tools.

**Changes:**
- `createPipe()` materializes Assignment records (via `assignment-store`)
  alongside existing PipeSlots.
- Payloads stored server-side via `payload-store` with SHA-256 integrity hash.
- `pipe-delivery.ts` DeliveryRecords created on each reducer action.
- Existing full-payload PTY delivery still used (dual-write: assignment record
  created, but delivery still pushes full payload).

**Persistence caveat:** Assignment and payload stores are currently in-memory
(`assignment-store.ts:69-76`, `payload-store.ts:58-62`). Assignments and
payloads do NOT survive server restart in this phase. Restart recovery for
assignments requires disk persistence (e.g., extending the existing
`{pipeId}.events.jsonl` pattern or adding SQLite — see Chat SQL Migration
feature). Until persistence is added, `pipe_list_assignments` after restart
returns an empty set; the existing `pipe-store` event-sourced recovery
rebuilds pipe/slot/lease state but not assignment-level state.

**Verification:**
- Assignment records created on every pipe action (observable via
  `GET /api/chat/pipes/assignments?assignee=...`).
- Full-payload PTY delivery unchanged — clients see no difference.
- `pipe_get_assignment(pipeId)` and `pipe_list_assignments()` return data
  for in-flight pipes (already registered, semantics unchanged).

### Phase 2: Dual-mode delivery (opt-in pull)

**Goal:** Clients that support assignments can opt into compact notifications.
Legacy clients continue receiving full payloads.

**Changes:**
- Add `deliveryMode` field to `ChatParticipant`: `'push' | 'pull'`.
  Default: `'push'` (backward compatible). Clients opt in via
  `chat_join(..., deliveryMode: 'pull')`.
- For `pull` participants: PTY delivers compact envelope.
- For `push` participants: PTY delivers full payload (unchanged).
- Both modes create the same Assignment record server-side.
- `pipe_submit` accepts both `assignmentId` and `pipeId` (the server resolves
  the active assignment from pipeId if no assignmentId is provided).

**Backward compatibility:**
- Existing clients (no code changes) continue working exactly as today.
- New clients opt in to pull mode and benefit from smaller PTY messages,
  explicit ack tracking, and reconnect recovery.

**Verification:**
- Mixed-mode pipe: push participant -> pull participant -> push participant
  works correctly.
- Pull participant can fetch payload, submit, and complete pipe.
- Push participant behavior unchanged.

### Phase 3: Shadow validation (optional)

**Goal:** Validate that pull delivery produces identical outcomes to push delivery.

**Changes:**
- For `push` participants, additionally create assignment records and track
  whether the submit would have matched the assignment-based flow.
- Log discrepancies (e.g., submit without fetch, submit for wrong assignment).
- Emit metrics: `pipe.delivery.mode`, `pipe.delivery.discrepancy`.

**Verification:**
- Shadow metrics show zero discrepancies for N consecutive pipes.
- No behavioral change for any participant.

**Decision gate:** Proceed to Phase 4 when shadow validation shows no
discrepancies for a configured threshold (e.g., 100 pipes or 7 days).

### Phase 4: Default to pull (opt-out push)

**Goal:** New participants default to pull mode.

**Changes:**
- `deliveryMode` default changes from `'push'` to `'pull'`.
- Clients that need push can still opt in via `chat_join(..., deliveryMode: 'push')`.
- LLM instructions updated to describe the notify-then-fetch flow as primary.

**Verification:**
- All active LLM clients (Claude Code, Codex) work with pull delivery.
- Push opt-out still functions for edge cases.

### Phase 5: Remove push delivery (cleanup)

**Goal:** Remove the legacy push code path.

**Changes:**
- Remove `deliveryMode` field (all participants use pull).
- Remove full-payload PTY construction in `runPipeReducer()`.
- Remove `requireLease = false` backward-compat path in `submitStage()`.
- `pipe_submit` only accepts `assignmentId` (pipeId fallback removed).
- Clean up dual-write paths.

**Verification:**
- All tests pass without push delivery code.
- No `deliveryMode: 'push'` references remain.

## Key Design Decisions

### 1. Dual-mode via participant flag, not global toggle

**Why:** Different LLM clients update at different speeds. A global toggle would
force all participants to upgrade simultaneously. A per-participant flag allows
gradual adoption within the same pipe.

**Trade-off:** Mixed-mode pipes add complexity to the reducer, but the assignment
model is the same regardless of delivery mode — only the PTY notification format
differs.

### 2. `pipe_submit` accepts both pipeId and assignmentId during transition

**Why:** Forcing assignmentId immediately would break all existing clients.
During Phase 2-4, the server resolves the active assignment from pipeId when
no assignmentId is provided. This is safe because one participant holds at most
one active lease.

**Risk:** If a participant somehow has two assignments for the same pipe (not
possible in current model), pipeId resolution would be ambiguous. Mitigated by
the one-lease-per-participant invariant.

**Removal:** Phase 5 removes pipeId fallback.

### 3. No dual-write for event log format

**Why:** Recovery events (`PipeRecoveryEvent`) are internal and not consumed by
clients. Adding assignment fields to recovery events is safe and backward
compatible — older event files without assignment fields are handled by
defaulting to null.

### 4. Shadow validation is optional

**Why:** The assignment model is a superset of the current model. If Phase 2
testing is thorough, shadow validation adds confidence but not correctness.
Skip if the team is confident in Phase 2 acceptance tests.

## Metrics for Phase Gate Decisions

| Metric | Phase 2 -> 3 gate | Phase 3 -> 4 gate | Phase 4 -> 5 gate |
|--------|-------------------|-------------------|-------------------|
| Pull-mode pipe completions | > 0 | N/A | > 50 |
| Shadow discrepancies | N/A | 0 for threshold | N/A |
| Push-mode participants remaining | N/A | N/A | 0 |
| Reconnect recovery success rate | > 90% | > 95% | > 99% |
| Average notification-to-fetch latency | Measured | Baselined | < 2s |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Pull participant fails to fetch payload | Re-notify policy with configurable backoff. Dead-letter after N attempts. |
| Mixed-mode pipe has inconsistent behavior | Assignment model is source of truth regardless of delivery mode. Tests cover mixed scenarios. |
| Server restart during Phase 2 | Pipe/slot/lease state recovers via existing event-sourced replay (`pipe-store.rehydrateFromEvents`). Assignment-level state (assignment-store, payload-store) is **lost** on restart until persistence is added. Push participants get full payload on re-delivery after recovery. Pull participants must fall back to `pipe_read_output(pipeId)` if `pipe_list_assignments` returns empty after restart. Persistence for assignments is a prerequisite for Phase 4 (default pull). |
| Client doesn't upgrade from push | Push remains functional until Phase 5. No forced migration. |
| Duplicate submit (push + pull race) | Assignment state machine rejects duplicate submits. `pipe_submit` is idempotent per assignment. |

## Files Affected by Phase

| Phase | Files | Nature of change |
|-------|-------|-----------------|
| 0 | `pipe-reducer.ts`, `pipe-store.ts` | Refactor (pure reducer, clock injection) |
| 0 | `types.ts` | Assignment types already exist; verify completeness |
| 1 | `pipe-store.ts`, `chat-registry.ts` | Wire assignment-store + payload-store into pipe lifecycle |
| 1 | `mcp.ts` | Tools already registered (`pipe_get_assignment`, `pipe_list_assignments`); update semantics |
| 2 | `types.ts` | `deliveryMode` on `ChatParticipant` |
| 2 | `chat-registry.ts` | Branching delivery: compact (via pipe-delivery.ts) vs full payload |
| 2 | `pipe-delivery.ts` | Compact notification formatting (already has delivery state machine) |
| 2 | `mcp.ts` | `pipe_submit` already accepts optional `assignmentId`; make it primary |
| 3 | `chat-registry.ts` | Shadow metrics logging |
| 4 | `types.ts`, `mcp.ts`, `claude-md-template.js` | Default flip, instruction update |
| 5 | `chat-registry.ts`, `pipe-store.ts`, `mcp.ts` | Dead code removal |
