# Pipe Upgrade: LLM Instructions Update

This document specifies the changes needed to LLM-facing instructions when
the pipe delivery model transitions from push to assignment-based pull.
It covers three instruction surfaces:

1. **MCP server instructions** (`mcp.ts` — `instructions` array in `createChatMcpServer`)
2. **CLAUDE.md template** (`bin/claude-md-template.js` — installed into user's CLAUDE.md)
3. **PTY interaction reminder** (`chat-registry.ts` — `PTY_INTERACTION_REMINDER`)

---

## 1. MCP Server Instructions (`mcp.ts`)

### New section: Pipe assignments (insert after "### Sending messages")

```
### Pipe assignments (notify-then-fetch)

When you are assigned a pipe stage, you receive a **compact notification**
via PTY containing an assignment envelope:

    [pipe-assignment] assignmentId=<id> pipeId=<id> stage=<n> role=<role>

This notification does NOT contain the full prompt or previous-stage output.
To get the authoritative payload, follow this sequence:

1. **Fetch the assignment:** `pipe_get_assignment(assignmentId)` — returns
   the full payload (prompt, context, previous output, submit instructions).
2. **Do your work** based on the fetched payload.
3. **Submit:** `pipe_submit(assignmentId, content)` — submit your output.

Do NOT act on the notification envelope alone. Always fetch first.

If you miss a notification (e.g., after reconnect), use
`pipe_list_assignments()` to discover any pending assignments.
```

### Updated quick reference entries

**Note:** `pipe_get_assignment`, `pipe_list_assignments`, and the optional
`assignmentId` parameter on `pipe_submit` already exist on this branch.
The changes below are semantic/description updates, not new tool registrations.

**Current signatures** (already in `mcp.ts`):
- `pipe_get_assignment(pipeId, paneId?)` — get assignment details for a pipe
- `pipe_list_assignments(paneId?)` — list active/pending assignments
- `pipe_submit(pipeId, content, assignmentId?, paneId?)` — submit with optional assignmentId

**Updated descriptions** (semantic shift to make assignment-based flow primary):
```
- `pipe_get_assignment(pipeId, paneId?)` — fetch your assignment details
  and authoritative payload for a pipe. Call this after receiving a compact
  notification. Returns role, stage, lease status, deadline, and full
  payload content. Use pipeId (the server resolves your active assignment).
- `pipe_list_assignments(paneId?)` — list your pending pipe assignments.
  Use after reconnect to discover work missed during disconnection.
  Note: assignments are in-memory only — returns empty after server restart
  until assignment persistence is added.
- `pipe_submit(pipeId, content, assignmentId?, paneId?)` — submit your
  output for a pipe stage. Pass `assignmentId` when available for explicit
  binding; `pipeId` alone still works (server resolves active assignment).
  Use this instead of `chat_send` when responding to pipe work.
- `pipe_read_output(pipeId, paneId?)` — read previous-stage output for a
  pipe. Returns only what the state machine says you can access now. Caller
  identity resolved from session.
```

### Updated chat_send entry

**Before:**
```
- `chat_send(message, to?, paneId?)` — ... Messages that start with `#pipe-`
  or reference a currently running `#pipe-*` are rejected — use `pipe_submit`
  instead.
```

**After:**
```
- `chat_send(message, to?, paneId?)` — ... Messages that start with `#pipe-`
  or reference a currently running `#pipe-*` are rejected — use
  `pipe_submit(assignmentId, content)` instead.
```

---

## 2. CLAUDE.md Template (`bin/claude-md-template.js`)

### Updated chat section

In the `### devglide-chat` section, add pipe assignment tools and update
the existing pipe tool descriptions:

**Add after `chat_members` bullet:**
```
- `pipe_get_assignment` — fetch full payload for a pipe assignment notification
- `pipe_list_assignments` — list pending pipe assignments (for reconnect recovery)
```

**Update existing bullet:**
```
- Before: `pipe_submit` — submit pipe stage output
- After:  `pipe_submit` — submit output for a pipe assignment (accepts assignmentId or pipeId)
```

**Add to the Session unification bullet:**
```
MCP tools (`chat_send`, `pipe_submit`, `pipe_get_assignment`, `chat_leave`)
can also adopt a REST-joined participant by passing `paneId`.
```

**Add new subsection in Chat description:**
```
- **Pipe delivery:** Pipe stages are delivered as compact assignment
  notifications. LLMs must call `pipe_get_assignment` to fetch the
  authoritative payload before acting. On reconnect, call
  `pipe_list_assignments` to recover pending work.
```

---

## 3. PTY Interaction Reminder (`chat-registry.ts`)

The `PTY_INTERACTION_REMINDER` appended to every delivered message currently
says:

```
Reply via `chat_send` (not shell output). For #pipe-* stages use
`pipe_submit`. Discussion only — execute only when explicitly assigned.
Start user-directed replies with @user.
```

**Update to:**
```
Reply via `chat_send` (not shell output). For pipe assignments: fetch with
`pipe_get_assignment`, then submit with `pipe_submit`. Discussion only —
execute only when explicitly assigned. Start user-directed replies with @user.
```

---

## 4. Compact Notification Format

The PTY notification envelope replaces the current full-payload delivery
message. The format should be concise and machine-parseable:

**Current (full payload, ~500-2000 chars):**
```
[DevGlide Chat] @system: #pipe-abc123 [linear | stage 2/3 | @claude-17]

Your output passes to the next stage.
Prompt: Analyze the authentication flow...

Read previous stage output: pipe_read_output(pipeId="abc123")

Submit: pipe_submit(pipeId="abc123", content="<your output>")
Do not use chat_send. Submit once, then wait.
```

**Upgraded (compact envelope, ~200 chars):**
```
[DevGlide Chat] @system: #pipe-abc123 [assignment]

assignmentId: asgn_7f3k2m
pipeId: abc123 | stage: 2/3 | role: stage-output | mode: linear

Fetch payload: pipe_get_assignment(assignmentId="asgn_7f3k2m")
Then submit: pipe_submit(assignmentId="asgn_7f3k2m", content="<output>")
```

---

## 5. Transitional Behavior (Phase 2-4)

During the dual-mode period, instructions must handle both flows:

### Push-mode participants (legacy, `deliveryMode: 'push'`)
- Continue receiving full-payload PTY messages.
- `pipe_submit(pipeId, content)` works as before.
- No mention of `pipe_get_assignment` needed — they already have the payload.

### Pull-mode participants (upgraded, `deliveryMode: 'pull'`)
- Receive compact notification envelopes.
- Must call `pipe_get_assignment(assignmentId)` before acting.
- `pipe_submit(assignmentId, content)` preferred; `pipeId` fallback accepted.

### MCP instructions during transition

The MCP server instructions should include both flows with a clear note:

```
### Pipe stages

When assigned a pipe stage, you will receive either:

**A. Full-payload delivery** (legacy) — contains the complete prompt and
   submit instructions inline. Act on it directly and call
   `pipe_submit(pipeId, content)`.

**B. Compact assignment notification** — contains only an assignmentId and
   metadata. You MUST fetch the payload first:
   1. `pipe_get_assignment(assignmentId)` — get full payload
   2. Do your work
   3. `pipe_submit(assignmentId, content)` — submit output

If you see an `assignmentId` in the notification, use flow B.
If you see the full prompt and submit instructions inline, use flow A.
```

This transitional text is removed in Phase 5 when push delivery is eliminated.

---

## 6. Reconnect Recovery Instructions

Add to MCP server instructions after the pipe assignments section:

```
### Reconnect recovery

If your pane was disconnected and you rejoin via `chat_join`, you may have
missed pipe notifications. Immediately after joining:

1. Call `pipe_list_assignments()` to check for pending assignments.
2. For each pending assignment, call `pipe_get_assignment(assignmentId)`.
3. Process and submit as normal.

**Note:** Assignments are currently in-memory only. After a server restart,
`pipe_list_assignments` returns empty — pipe/slot state recovers via
event-sourced replay, but assignment-level state does not. Until assignment
persistence is added, reconnect recovery works only for pane disconnects
(not server restarts). After a server restart, fall back to
`pipe_read_output(pipeId)` if you know which pipe you were working on.
```

---

## 7. Implementation Checklist

- [ ] Update `instructions` array in `createChatMcpServer()` (`mcp.ts`)
- [ ] Update `pipe_get_assignment` tool description to reflect payload fetch semantics (tool already registered)
- [ ] Update `pipe_list_assignments` tool description to note in-memory limitation (tool already registered)
- [ ] `pipe_submit` already accepts optional `assignmentId` — update description to make it primary
- [ ] Update `PTY_INTERACTION_REMINDER` in `chat-registry.ts`
- [ ] Update `getClaudeMdContent()` in `bin/claude-md-template.js`
- [ ] Bump `VERSION` in `claude-md-template.js`
- [ ] Add transitional dual-mode instructions (Phase 2)
- [ ] Remove transitional instructions (Phase 5)
- [ ] Update compact notification format in `runPipeReducer()` delivery message construction
