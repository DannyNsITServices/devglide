# Pipe Upgrade: Acceptance Test Plan

This document defines the layered acceptance suite for the upgraded
assignment-based pipe delivery model.

## Test Layers

### Layer 1: Deterministic reducer/unit tests

Pure function tests for `reduce(state, event) -> [nextState, effects]`.
No I/O, no timers, injectable clock.

### Layer 2: REST/integration tests

HTTP-level tests for the assign-fetch-submit-status flow via the REST API.
Uses a running server instance.

### Layer 3: MCP canary tests

Live MCP tool invocations testing notification, adoption, and end-to-end
pipe completion. Minimal set — validates MCP plumbing, not business logic.

---

## Structured Case Definitions

Each test case uses this structure:

```typescript
interface AcceptanceCase {
  /** Stable identifier for cross-reference and reruns. */
  caseId: string;
  /** Human-readable description. */
  title: string;
  /** Which layer: 'reducer' | 'rest' | 'mcp' */
  layer: 'reducer' | 'rest' | 'mcp';
  /** The authoritative source of truth for the expected outcome. */
  oracle: string;
  /** Artifacts that MUST be present for a pass verdict. */
  expectedArtifacts: string[];
  /** Artifacts that MUST NOT be present (indicates a bug). */
  forbiddenArtifacts: string[];
  /** Whether this case should produce identical results on rerun. */
  rerunExpectation: 'deterministic' | 'eventually-consistent' | 'non-deterministic';
  /** Verdict taxonomy. */
  verdictOptions: ['pass', 'protocol_fail', 'invalid_unverified'];
}
```

---

## Layer 1: Reducer Unit Tests

### REDUCE-001: Linear pipe — happy path through 3 stages

- **caseId:** `REDUCE-001`
- **oracle:** Pure reducer output given start event + sequential stage-output events
- **events:** `start(linear, [A,B,C], prompt)` -> `stage-output(A, s1)` -> `stage-output(B, s2)` -> `stage-output(C, s3)`
- **expected effects:**
  - After start: `[assign(A, stage=1)]`
  - After A submits: `[assign(B, stage=2)]`
  - After B submits: `[assign(C, stage=3)]`
  - After C submits: `[complete(pipeId)]`
- **forbidden:** No duplicate assign effects. No assign after complete.
- **rerun:** deterministic

### REDUCE-002: Merge pipe — fan-out then synthesize

- **caseId:** `REDUCE-002`
- **events:** `start(merge, [A,B,synth], prompt)` -> `fan-out(A)` -> `fan-out(B)` -> `synth-output(synth)`
- **expected effects:**
  - After start: `[assign(A, fan-out), assign(B, fan-out)]`
  - After A submits: no new effect (waiting for B)
  - After B submits: `[assign(synth, synth-request)]`
  - After synth submits: `[complete(pipeId)]`
- **rerun:** deterministic

### REDUCE-003: Merge-all pipe — all participate + synthesize

- **caseId:** `REDUCE-003`
- **events:** `start(merge-all, [A,B,C], prompt)` -> `fan-out(A)` -> `fan-out(B)` -> `fan-out(C)` -> `synth-output(C)`
- **expected effects:**
  - After start: `[assign(A, fan-out), assign(B, fan-out), assign(C, fan-out)]`
  - After all fan-outs: `[assign(C, synth-request)]`
  - After C's synth: `[complete(pipeId)]`
- **rerun:** deterministic

### REDUCE-004: Idempotent replay — same events produce same state

- **caseId:** `REDUCE-004`
- **oracle:** Reducer applied twice to same event stream yields identical state
- **rerun:** deterministic

### REDUCE-005: Terminal state — no actions after failure

- **caseId:** `REDUCE-005`
- **events:** `start(linear, [A,B])` -> `failed(timeout)`
- **expected:** `computeNextActions` returns `[]`
- **forbidden:** Any assign effect

### REDUCE-006: Terminal state — no actions after cancellation

- **caseId:** `REDUCE-006`
- **events:** `start(linear, [A,B])` -> `cancelled(user)`
- **expected:** `computeNextActions` returns `[]`

### REDUCE-007: Clock injection — deadline calculation uses injected time

- **caseId:** `REDUCE-007`
- **oracle:** Lease deadline = injected_now + stageTimeoutMs
- **rerun:** deterministic (injectable clock)

---

## Layer 2: REST Integration Tests

**Actual API routes** (from `mcp.ts` and chat router):
- List assignments: `GET /api/chat/pipes/assignments?assignee=<name>&projectId=<id>`
- Get assignment: `GET /api/chat/pipes/:pipeId/assignment?projectId=<id>` (with `x-pane-id` header)
- Submit: `POST /api/chat/pipes/:pipeId/submit` body `{from, content, assignmentId?, projectId?}`
- Read output: `GET /api/chat/pipes/:pipeId/output?projectId=<id>` (with `x-pane-id` header)
- Pipe status: `GET /api/chat/pipes/:pipeId/status?projectId=<id>`
- Send message: `POST /api/chat/send` body `{from, message, to?}`

### REST-001: Happy path — assign, fetch, submit, complete

- **caseId:** `REST-001`
- **setup:** Create pipe via `POST /api/chat/send` with body `{from: "user", message: "/linear-pipe @A @B do task"}`. 2-stage linear.
- **steps:**
  1. `GET /api/chat/pipes/assignments?assignee=A` -> returns assignment with role/stage info
  2. `GET /api/chat/pipes/:pipeId/assignment` (with `x-pane-id: A-pane`) -> returns assignment details
  3. Assert response includes role, stage, lease status
  4. `POST /api/chat/pipes/:pipeId/submit` with `{from: A, content: "stage 1 output"}`
  5. Assert submit accepted (200)
  6. Repeat for participant B
  7. `GET /api/chat/pipes/:pipeId/status` -> assert `completed`
- **expectedArtifacts:** Two assignment records, both in `submitted` state
- **forbiddenArtifacts:** No assignment in `expired` or `failed` state
- **rerun:** deterministic

### REST-002: Wrong-channel rejection — chat_send for pipe content

- **caseId:** `REST-002`
- **steps:**
  1. Start a pipe with participant A
  2. `POST /api/chat/send` with `{from: "A", message: "#pipe-abc123 my output"}`
  3. Assert rejection (message contains `#pipe-` prefix)
- **expected:** Error mentions `pipe_submit`
- **rerun:** deterministic

### REST-003: Duplicate submit — second submit rejected

- **caseId:** `REST-003`
- **steps:**
  1. A submits via `POST /api/chat/pipes/:pipeId/submit` — succeeds
  2. A submits again to same pipe
  3. Assert rejection with `PIPE_ALREADY_SUBMITTED`
- **forbidden:** Second submit changing pipe state
- **rerun:** deterministic

### REST-004: Timeout — stage deadline expires

- **caseId:** `REST-004`
- **setup:** Pipe with `stageTimeoutMs: 100` (very short for testing)
- **steps:**
  1. Start pipe, assignment created for A
  2. Wait > 100ms without fetch or submit
  3. Assert pipe status `failed` (for `fail` policy) or escalation message (for `escalate`)
- **rerun:** eventually-consistent (timing-dependent)

### REST-005: Unauthorized submit — stale assignee rejected

- **caseId:** `REST-005`
- **steps:**
  1. Start pipe, A gets assignment/lease
  2. Assignment expires / lease released
  3. A attempts `POST /api/chat/pipes/:pipeId/submit` with `{from: A, content}`
  4. Assert rejection with `PIPE_LEASE_NOT_HELD`
- **forbidden:** Stale submit advancing pipe state
- **rerun:** deterministic

### REST-006: Reconnect recovery — list assignments after rejoin

- **caseId:** `REST-006`
- **steps:**
  1. Start pipe, A gets assignment
  2. Simulate A disconnect (`POST /api/chat/leave` with `{name: A}`)
  3. A rejoins (`POST /api/chat/join`)
  4. `GET /api/chat/pipes/assignments?assignee=A` returns the pending assignment
  5. A fetches and submits successfully
- **expected:** Pipe completes normally despite reconnect
- **note:** Only works for pane disconnects (not server restarts) until assignment persistence is added
- **rerun:** deterministic

### REST-007: No-ack delivery retry — re-notify after timeout

- **caseId:** `REST-007`
- **setup:** Pipe with re-notify policy enabled
- **steps:**
  1. Start pipe, notification delivered to A
  2. A does not fetch within ack window
  3. Assert re-notification sent (observable via `pipe-delivery.ts` `DeliveryRecord.notifyAttempts` counter or via `GET /api/chat/pipes/:pipeId/status` timing data)
- **rerun:** eventually-consistent

### REST-008: Dropped initial notification — assignee can still fetch

- **caseId:** `REST-008`
- **oracle:** Assignment/delivery record exists server-side even if PTY notification never reaches client
- **steps:**
  1. Start pipe (assignment + delivery record created)
  2. Simulate notification delivery failure (e.g., participant has no PTY)
  3. A calls `GET /api/chat/pipes/assignments?assignee=A` — finds the assignment
  4. A fetches details via `GET /api/chat/pipes/:pipeId/assignment` and submits
  5. Pipe completes
- **expected:** Pipe completes despite dropped notification
- **forbidden:** Pipe stuck in running state indefinitely
- **rerun:** deterministic

### REST-009: Mixed-mode pipe — push participant + pull participant

- **caseId:** `REST-009`
- **setup:** 2-stage linear pipe. A = push mode, B = pull mode.
- **steps:**
  1. A receives full-payload PTY delivery
  2. A submits via `pipe_submit(pipeId, content)` (no assignmentId)
  3. B receives compact notification
  4. B fetches assignment, submits via `pipe_submit(assignmentId, content)`
  5. Pipe completes
- **expected:** Both delivery modes work in same pipe
- **rerun:** deterministic

### REST-010: Payload integrity — fetched payload matches stored payload

- **caseId:** `REST-010`
- **steps:**
  1. Start pipe, assignment created with payload hash
  2. Fetch payload via assignment
  3. Assert content matches and hash is correct
- **rerun:** deterministic

---

## Layer 3: MCP Canary Tests

### MCP-001: pipe_get_assignment tool — returns assignment details

- **caseId:** `MCP-001`
- **steps:** Call `pipe_get_assignment(pipeId)` via MCP tool (current signature takes pipeId, not assignmentId)
- **expected:** Returns assignment details including role, stage, lease status, deadline
- **rerun:** deterministic

### MCP-002: pipe_list_assignments tool — lists pending

- **caseId:** `MCP-002`
- **steps:** Call `pipe_list_assignments()` via MCP tool after pipe start
- **expected:** Returns array with at least one active assignment for the caller
- **rerun:** deterministic

### MCP-003: pipe_submit with assignmentId — completes stage

- **caseId:** `MCP-003`
- **steps:** Submit via MCP `pipe_submit(pipeId, content, assignmentId)` — assignmentId is optional param
- **expected:** Returns success with slot info
- **rerun:** deterministic

### MCP-004: pipe_submit with pipeId only — backward compat

- **caseId:** `MCP-004`
- **steps:** Submit via MCP `pipe_submit(pipeId, content)` (no assignmentId)
- **expected:** Server resolves active lease/assignment and accepts submit
- **rerun:** deterministic

---

## Verdict Taxonomy

| Verdict | Meaning |
|---------|---------|
| `pass` | All expected artifacts present, no forbidden artifacts, oracle satisfied |
| `protocol_fail` | The pipe protocol was violated (wrong state transition, duplicate effect, stale access) |
| `invalid_unverified` | Test setup or assertion is invalid; result cannot be trusted |

## Implementation Notes

- Layer 1 tests go in `src/apps/chat/services/pipe-reducer.test.ts` (extend existing)
- Layer 2 tests go in `src/apps/chat/services/chat-registry.pipe-submit.test.ts` (extend existing)
  or new file `src/apps/chat/services/pipe-upgrade-acceptance.test.ts`
- Layer 3 tests go in `src/apps/chat/src/mcp.test.ts` (extend existing)
- All Layer 1 tests must use injectable clock (no `Date.now()`)
- Layer 2 tests should use the existing test server setup pattern
- Case IDs are stable — do not renumber when adding/removing cases
