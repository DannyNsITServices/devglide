# Pipe Final Output — User-Only Delivery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route pipe final output to the user only (dashboard + chat history) — skip PTY injection to LLM participants so long output doesn't clutter their terminals.

**Architecture:** The change is surgical. In `runPipeReducer()`, the final-output broadcast loop currently iterates over ALL non-detached participants and PTY-delivers the result. We replace that broadcast with a no-PTY approach: the message is still persisted in chat history and emitted via Socket.IO (so the dashboard shows it in real-time), but the `for (const p of participants)` PTY delivery loop is removed. The `to` field on the persisted message changes from `null` (broadcast) to `'user'` (semantic-only target) so the dashboard header reads `@author -> @user` instead of implying all-broadcast.

**Tech Stack:** TypeScript (chat-registry.ts), Vitest (tests), vanilla JS (dashboard page.js)

---

### Task 1: Write failing test — final output skips PTY delivery to LLMs

**Files:**
- Modify: `src/apps/chat/services/chat-registry.pipe-submit.test.ts`

This test verifies that when a pipe completes, the final output message is NOT PTY-delivered to any LLM participant.

- [ ] **Step 1: Write the failing test**

Add this test at the end of the existing `describe('submitPipeStage')` block (after the `preserves the pipe anchor on the public final chat message` test, around line 431):

```typescript
  it('final output is NOT PTY-delivered to LLM participants (user-only delivery)', async () => {
    const writesA: string[] = [];
    const writesB: string[] = [];
    globalPtys.set('pane-a', {
      ptyProcess: { write: vi.fn((c: string) => { writesA.push(c); }) } as never,
      chunks: [],
      totalLen: 0,
    });
    globalPtys.set('pane-b', {
      ptyProcess: { write: vi.fn((c: string) => { writesB.push(c); }) } as never,
      chunks: [],
      totalLen: 0,
    });
    const alice = registry.join('alice', 'llm', 'pane-a', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'pane-b', 'bob', '\r');

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} do work`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-chat')[0]?.pipeId;
    expect(pipeId).toBeDefined();

    // Clear writes from pipe setup (handoff notifications)
    writesA.length = 0;
    writesB.length = 0;

    // Alice submits stage 1
    const aliceSubmit = registry.submitPipeStage(pipeId!, alice.name, 'stage 1 output', 'project-chat');
    await vi.advanceTimersByTimeAsync(3_000);
    await aliceSubmit;

    // Clear writes from stage 1 handoff to bob
    writesA.length = 0;
    writesB.length = 0;

    // Bob submits final stage
    const bobSubmit = registry.submitPipeStage(pipeId!, bob.name, 'final output content', 'project-chat');
    await vi.advanceTimersByTimeAsync(5_000);
    await bobSubmit;

    // Neither LLM should have received the final output via PTY
    const allWrites = [...writesA, ...writesB];
    const finalDeliveries = allWrites.filter(w => w.includes('final output content'));
    expect(finalDeliveries).toEqual([]);

    registry.leave(alice.name);
    registry.leave(bob.name);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/apps/chat/services/chat-registry.pipe-submit.test.ts -t "final output is NOT PTY-delivered"`
Expected: FAIL — the current code broadcasts final output to all PTYs, so `finalDeliveries` will contain entries.

---

### Task 2: Write failing test — final output message has `to: 'user'`

**Files:**
- Modify: `src/apps/chat/services/chat-registry.pipe-submit.test.ts`

This test verifies that the persisted final output message has `to: 'user'` instead of `to: null`.

- [ ] **Step 1: Write the failing test**

Add after the previous test:

```typescript
  it('final output message is persisted with to="user" (not broadcast)', async () => {
    globalPtys.set('pane-a', {
      ptyProcess: { write: vi.fn() } as never,
      chunks: [],
      totalLen: 0,
    });
    globalPtys.set('pane-b', {
      ptyProcess: { write: vi.fn() } as never,
      chunks: [],
      totalLen: 0,
    });
    const alice = registry.join('alice', 'llm', 'pane-a', 'alice', '\r');
    const bob = registry.join('bob', 'llm', 'pane-b', 'bob', '\r');

    const startPromise = registry.send('user', `/linear-pipe @${alice.name} @${bob.name} do work`);
    await vi.advanceTimersByTimeAsync(2_000);
    await startPromise;

    const pipeId = registry.getActivePipes('project-chat')[0]?.pipeId;

    const aliceSubmit = registry.submitPipeStage(pipeId!, alice.name, 'stage 1 output', 'project-chat');
    await vi.advanceTimersByTimeAsync(3_000);
    await aliceSubmit;

    chatStoreMock.appendMessage.mockClear();

    const bobSubmit = registry.submitPipeStage(pipeId!, bob.name, 'final output', 'project-chat');
    await vi.advanceTimersByTimeAsync(5_000);
    await bobSubmit;

    const finalMessage = chatStoreMock.appendMessage.mock.calls
      .map(([message]) => message)
      .find((message: any) => message?.pipe?.role === 'final');

    expect(finalMessage).toBeDefined();
    expect(finalMessage!.to).toBe('user');

    registry.leave(alice.name);
    registry.leave(bob.name);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/apps/chat/services/chat-registry.pipe-submit.test.ts -t "final output message is persisted with to"`
Expected: FAIL — currently `to: null` (broadcast).

---

### Task 3: Implement the change — skip PTY broadcast, set `to: 'user'`

**Files:**
- Modify: `src/apps/chat/services/chat-registry.ts:1575-1593`

The change is inside `runPipeReducer()`. We modify the final-output block to:
1. Set `to: 'user'` instead of `to: null`
2. Remove the PTY broadcast loop entirely

- [ ] **Step 1: Apply the code change**

In `src/apps/chat/services/chat-registry.ts`, replace lines 1575-1593 (the final output section inside `if (state.hasFinal)`):

**Before:**
```typescript
    // Read the final output from pipe state and broadcast it to all participants.
    // This is the ONLY pipe output that enters chat history and LLM context.
    const finalContent = readFinalOutput(pipeId, projectId);
    if (finalContent) {
      // Render pipe result as a normal chat message from the actual author
      const resultMsg = appendMessage({
        from: finalContent.from, to: null,
        body: ensurePipeAnchor(finalContent.body, pipeId),
        type: 'message',
        pipe: { pipeId, mode: state.mode, role: 'final' },
      }, projectId);
      emitToProject('chat:message', resultMsg, projectId);
      // Broadcast to all PTYs — this is the public final result
      for (const p of participants.values()) {
        if (p.paneId && p.projectId === projectId && !p.detached) {
          await deliverToPty(p.name, projectId, resultMsg);
        }
      }
    }
```

**After:**
```typescript
    // Read the final output from pipe state and persist it for the user.
    // Final output is user-only: persisted in chat history and emitted to
    // dashboard via Socket.IO, but NOT PTY-delivered to LLM participants.
    // This prevents long output from cluttering LLM terminals.
    const finalContent = readFinalOutput(pipeId, projectId);
    if (finalContent) {
      const resultMsg = appendMessage({
        from: finalContent.from, to: 'user',
        body: ensurePipeAnchor(finalContent.body, pipeId),
        type: 'message',
        pipe: { pipeId, mode: state.mode, role: 'final' },
      }, projectId);
      emitToProject('chat:message', resultMsg, projectId);
      // No PTY delivery — user sees it on dashboard only.
    }
```

- [ ] **Step 2: Run both new tests to verify they pass**

Run: `npx vitest run src/apps/chat/services/chat-registry.pipe-submit.test.ts -t "final output"`
Expected: Both new tests PASS.

- [ ] **Step 3: Run the full pipe-submit test suite to check for regressions**

Run: `npx vitest run src/apps/chat/services/chat-registry.pipe-submit.test.ts`
Expected: All tests PASS. The existing `preserves the pipe anchor on the public final chat message` test should still pass because `appendMessage` is still called — only PTY delivery is removed.

- [ ] **Step 4: Commit**

```bash
git add src/apps/chat/services/chat-registry.ts src/apps/chat/services/chat-registry.pipe-submit.test.ts
git commit -m "feat(chat): route pipe final output to user only, skip LLM PTY delivery

Final pipe output was being PTY-injected to all LLM participants,
cluttering terminals with long content where auto-enter wasn't working.
Now final output is persisted in chat history and emitted to dashboard
via Socket.IO but not PTY-delivered to LLMs. The to field is set to
'user' so the dashboard header reads @author -> @user."
```

---

### Task 4: Run the full chat test suite

**Files:**
- Test: `src/apps/chat/services/chat-registry.targeted-delivery.test.ts`
- Test: `src/apps/chat/services/chat-registry.pipe-submit.test.ts`
- Test: `src/apps/chat/services/pipe-*.test.ts`
- Test: `src/routers/chat.test.ts`

- [ ] **Step 1: Run all chat-related tests**

Run: `npx vitest run src/apps/chat/services/ src/routers/chat.test.ts`
Expected: All tests PASS.

- [ ] **Step 2: Run the full project build to check for type errors**

Run: `pnpm build`
Expected: PASS — no type errors. The change only modifies a string literal (`null` -> `'user'`) and removes code, so no new type issues.

---

### Task 5: Verify dashboard rendering still works for pipe final output

**Files:**
- Read: `src/apps/chat/public/page.js:1484-1496`

The dashboard already handles `pipe.role === 'final'` messages via `buildPipeOutputEl()`. The `to` field change from `null` to `'user'` affects the header rendering via `formatRecipientHeader(msg.from, msg.to)`.

- [ ] **Step 1: Check that `formatRecipientHeader` handles `to: 'user'` correctly**

Search `page.js` for `formatRecipientHeader` and verify it renders `'user'` in the `to` field as `@author -> @user`. The pipe final uses `buildPipeOutputEl` which may or may not call `formatRecipientHeader` — verify the actual rendering path.

- [ ] **Step 2: If needed, adjust the pipe final output renderer**

If `buildPipeOutputEl` renders its own header and doesn't use the `to` field for addressing display, no change is needed. The `to: 'user'` is primarily for the persisted message semantics and won't affect the "Final output" label shown in the pipe output card.

- [ ] **Step 3: Commit if any dashboard changes were needed**

```bash
git add src/apps/chat/public/page.js
git commit -m "fix(chat): update dashboard pipe final rendering for user-only delivery"
```

(Skip this commit if no changes were needed.)
