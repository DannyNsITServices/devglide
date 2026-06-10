import { describe, it, expect, beforeEach } from "vitest";
import * as pipeStore from "./pipe-store.js";
import * as assignmentQueries from "./pipe-assignment-queries.js";

beforeEach(() => {
  pipeStore._resetForTest();
});

// ── Helper ────────────────────────────────────────────────────────────────────

function createLinearPipe(assignees = ["alice", "bob", "carol"]) {
  return pipeStore.createPipe(
    "pipe-1",
    "linear",
    assignees,
    "test prompt",
    "proj-1",
  );
}

function createMergePipe(assignees = ["alice", "bob", "carol"]) {
  return pipeStore.createPipe(
    "pipe-2",
    "merge",
    assignees,
    "test prompt",
    "proj-1",
  );
}

// ── createPipe ────────────────────────────────────────────────────────────────

describe("pipe-store createPipe", () => {
  it("creates a linear pipe with correct slots", () => {
    const pipe = createLinearPipe();
    expect(pipe.pipeId).toBe("pipe-1");
    expect(pipe.mode).toBe("linear");
    expect(pipe.status).toBe("running");
    expect(pipe.slots.size).toBe(3);

    const alice = pipe.slots.get("alice")![0];
    expect(alice.role).toBe("stage-output");
    expect(alice.stage).toBe(1);
    expect(alice.status).toBe("pending");

    const bob = pipe.slots.get("bob")![0];
    expect(bob.role).toBe("stage-output");
    expect(bob.stage).toBe(2);

    const carol = pipe.slots.get("carol")![0];
    expect(carol.role).toBe("final");
    expect(carol.stage).toBe(3);
  });

  it("creates a merge pipe with fan-out and synthesizer slots", () => {
    const pipe = createMergePipe();
    expect(pipe.mode).toBe("merge");
    expect(pipe.slots.size).toBe(3);

    expect(pipe.slots.get("alice")![0].role).toBe("fan-out");
    expect(pipe.slots.get("bob")![0].role).toBe("fan-out");
    expect(pipe.slots.get("carol")![0].role).toBe("final");
  });

  it("creates a merge-all pipe with fan-out for everyone and synthesizer role for last", () => {
    const pipe = pipeStore.createPipe(
      "pipe-3",
      "merge-all",
      ["alice", "bob"],
      "test",
      "proj-1",
    );
    expect(pipe.mode).toBe("merge-all");
    expect(pipe.slots.size).toBe(2);

    const alice = pipe.slots.get("alice")!;
    expect(alice).toHaveLength(1);
    expect(alice[0].role).toBe("fan-out");

    const bob = pipe.slots.get("bob")!;
    expect(bob).toHaveLength(2);
    expect(bob[0].role).toBe("fan-out");
    expect(bob[1].role).toBe("final");
  });

  it("creates an explain pipe with merge-all style slots", () => {
    const pipe = pipeStore.createPipe(
      "pipe-4",
      "explain",
      ["alice", "bob"],
      "teach this",
      "proj-1",
    );
    expect(pipe.mode).toBe("explain");
    expect(pipe.slots.get("alice")?.map((slot) => slot.role)).toEqual([
      "fan-out",
    ]);
    expect(pipe.slots.get("bob")?.map((slot) => slot.role)).toEqual([
      "fan-out",
      "final",
    ]);
  });

  it("creates a summarize pipe with merge-all style slots", () => {
    const pipe = pipeStore.createPipe(
      "pipe-5",
      "summarize",
      ["alice", "bob"],
      "digest this",
      "proj-1",
    );
    expect(pipe.mode).toBe("summarize");
    expect(pipe.slots.get("alice")?.map((slot) => slot.role)).toEqual([
      "fan-out",
    ]);
    expect(pipe.slots.get("bob")?.map((slot) => slot.role)).toEqual([
      "fan-out",
      "final",
    ]);
  });
});

// ── Lease management ──────────────────────────────────────────────────────────

describe("pipe-store lease management", () => {
  it("grants a lease to an assignee", () => {
    createLinearPipe();
    const result = pipeStore.grantLease("pipe-1", "alice", "proj-1");
    expect(result.ok).toBe(true);
    expect(result.lease?.assignee).toBe("alice");
    expect(result.lease?.pipeId).toBe("pipe-1");

    const lease = pipeStore.getActiveLease("alice", "proj-1");
    expect(lease?.pipeId).toBe("pipe-1");
  });

  it("rejects lease for a different pipe when one is already held", () => {
    createLinearPipe();
    pipeStore.createPipe(
      "pipe-other",
      "linear",
      ["alice", "bob"],
      "other",
      "proj-1",
    );
    pipeStore.grantLease("pipe-1", "alice", "proj-1");

    const result = pipeStore.grantLease("pipe-other", "alice", "proj-1");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already holds a lease");
  });

  it("allows re-granting for the same pipe (idempotent)", () => {
    createLinearPipe();
    pipeStore.grantLease("pipe-1", "alice", "proj-1");
    const result = pipeStore.grantLease("pipe-1", "alice", "proj-1");
    expect(result.ok).toBe(true);
  });

  it("rejects lease for non-assignee", () => {
    createLinearPipe();
    const result = pipeStore.grantLease("pipe-1", "stranger", "proj-1");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not an assignee");
  });

  it("rejects lease for already-submitted slot", () => {
    createLinearPipe();
    pipeStore.grantLease("pipe-1", "alice", "proj-1");
    pipeStore.submitStage("pipe-1", "alice", "output", "proj-1", true);

    const result = pipeStore.grantLease("pipe-1", "alice", "proj-1");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("has no pending tasks");
  });

  it("releases a lease", () => {
    createLinearPipe();
    pipeStore.grantLease("pipe-1", "alice", "proj-1");
    pipeStore.releaseLease("alice", "proj-1");
    expect(pipeStore.getActiveLease("alice", "proj-1")).toBeUndefined();
  });
});

// ── Stage submission ──────────────────────────────────────────────────────────

describe("pipe-store submitStage", () => {
  it("accepts submission with valid lease", () => {
    createLinearPipe();
    pipeStore.grantLease("pipe-1", "alice", "proj-1");
    const result = pipeStore.submitStage(
      "pipe-1",
      "alice",
      "my output",
      "proj-1",
      true,
    );
    expect(result.ok).toBe(true);
    expect(result.slot?.status).toBe("submitted");
    expect(result.slot?.content).toBe("my output");
    // Lease should be released after submission
    expect(pipeStore.getActiveLease("alice", "proj-1")).toBeUndefined();
  });

  it("rejects submission without lease when requireLease=true", () => {
    createLinearPipe();
    // Don't grant a lease
    const result = pipeStore.submitStage(
      "pipe-1",
      "alice",
      "output",
      "proj-1",
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not hold a lease");
  });

  it("rejects double submission", () => {
    createLinearPipe();
    pipeStore.grantLease("pipe-1", "alice", "proj-1");
    pipeStore.submitStage("pipe-1", "alice", "first", "proj-1", true);

    const result = pipeStore.submitStage(
      "pipe-1",
      "alice",
      "second",
      "proj-1",
      false,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already submitted");
  });

  it("rejects submission for non-running pipe", () => {
    createLinearPipe();
    pipeStore.markPipeStatus("pipe-1", "cancelled", "proj-1");
    const result = pipeStore.submitStage(
      "pipe-1",
      "alice",
      "output",
      "proj-1",
      false,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cancelled");
  });

  it("rejects submission from non-assignee", () => {
    createLinearPipe();
    const result = pipeStore.submitStage(
      "pipe-1",
      "stranger",
      "output",
      "proj-1",
      false,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not an assignee");
  });

  it("merge-all synthesizer submits fan-out before final", () => {
    pipeStore.createPipe(
      "pipe-3",
      "merge-all",
      ["alice", "bob"],
      "test",
      "proj-1",
    );

    const firstLease = pipeStore.grantLease("pipe-3", "bob", "proj-1");
    expect(firstLease.ok).toBe(true);
    expect(firstLease.lease?.slotRole).toBe("fan-out");

    const firstSubmit = pipeStore.submitStage(
      "pipe-3",
      "bob",
      "blind analysis",
      "proj-1",
      true,
    );
    expect(firstSubmit.ok).toBe(true);
    expect(firstSubmit.slot?.role).toBe("fan-out");

    const secondLease = pipeStore.grantLease("pipe-3", "bob", "proj-1");
    expect(secondLease.ok).toBe(true);
    expect(secondLease.lease?.slotRole).toBe("final");

    const secondSubmit = pipeStore.submitStage(
      "pipe-3",
      "bob",
      "merged answer",
      "proj-1",
      true,
    );
    expect(secondSubmit.ok).toBe(true);
    expect(secondSubmit.slot?.role).toBe("final");
  });
});

// ── Queries ───────────────────────────────────────────────────────────────────

describe("pipe-store queries", () => {
  it("getStageOutput returns submitted content by stage number", () => {
    createLinearPipe();
    pipeStore.grantLease("pipe-1", "alice", "proj-1");
    pipeStore.submitStage("pipe-1", "alice", "stage 1 output", "proj-1", true);

    const output = pipeStore.getStageOutput("pipe-1", 1, "proj-1");
    expect(output).toEqual({ from: "alice", body: "stage 1 output" });

    // Stage 2 not yet submitted
    expect(pipeStore.getStageOutput("pipe-1", 2, "proj-1")).toBeUndefined();
  });

  it("getFanOutOutputs returns all submitted fan-out content", () => {
    createMergePipe();
    pipeStore.grantLease("pipe-2", "alice", "proj-1");
    pipeStore.submitStage("pipe-2", "alice", "alice output", "proj-1", true);
    pipeStore.grantLease("pipe-2", "bob", "proj-1");
    pipeStore.submitStage("pipe-2", "bob", "bob output", "proj-1", true);

    const outputs = pipeStore.getFanOutOutputs("pipe-2", "proj-1");
    expect(outputs.size).toBe(2);
    expect(outputs.get("alice")).toBe("alice output");
    expect(outputs.get("bob")).toBe("bob output");
  });

  it("getPipeStatus returns full pipe summary", () => {
    createLinearPipe();
    pipeStore.grantLease("pipe-1", "alice", "proj-1");

    const status = pipeStore.getPipeStatus("pipe-1", "proj-1");
    expect(status).toBeDefined();
    expect(status!.pipeId).toBe("pipe-1");
    expect(status!.slots).toHaveLength(3);
    expect(status!.leases).toHaveLength(1);
    expect(status!.leases[0].assignee).toBe("alice");
  });
});

// ── Pending pipe queue ────────────────────────────────────────────────────────

describe("pipe-store pending pipe queue", () => {
  it("tracks pending pipes for lease conflicts", () => {
    createLinearPipe();
    pipeStore.createPipe(
      "pipe-other",
      "linear",
      ["alice", "bob"],
      "other",
      "proj-1",
    );
    pipeStore.grantLease("pipe-1", "alice", "proj-1");

    // pipe-other can't get a lease for alice — add to pending
    pipeStore.addPendingPipe("alice", "proj-1", "pipe-other");

    // Pop returns the pending pipe
    const pending = pipeStore.popPendingPipes("alice", "proj-1");
    expect(pending).toEqual(["pipe-other"]);

    // Second pop returns empty
    expect(pipeStore.popPendingPipes("alice", "proj-1")).toEqual([]);
  });

  it("returns empty array when no pending pipes", () => {
    expect(pipeStore.popPendingPipes("nobody", "proj-1")).toEqual([]);
  });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe("pipe-store lifecycle", () => {
  it("markPipeStatus returns released assignees so callers can drain pending queues", () => {
    createLinearPipe();
    pipeStore.createPipe(
      "pipe-blocked",
      "linear",
      ["alice", "bob"],
      "blocked",
      "proj-1",
    );
    pipeStore.grantLease("pipe-1", "alice", "proj-1");

    // pipe-blocked is queued behind alice's lease on pipe-1
    pipeStore.addPendingPipe("alice", "proj-1", "pipe-blocked");

    // Cancel pipe-1 — alice's lease is released
    const released = pipeStore.markPipeStatus("pipe-1", "cancelled", "proj-1");
    expect(released).toContain("alice");
    expect(pipeStore.getActiveLease("alice", "proj-1")).toBeUndefined();

    // Caller can now drain pending pipes for the released assignees
    const pending = pipeStore.popPendingPipes("alice", "proj-1");
    expect(pending).toEqual(["pipe-blocked"]);

    // pipe-blocked can now get alice's lease
    const leaseResult = pipeStore.grantLease("pipe-blocked", "alice", "proj-1");
    expect(leaseResult.ok).toBe(true);
  });

  it("markPipeStatus on failure also enables pending drain", () => {
    createLinearPipe();
    pipeStore.createPipe(
      "pipe-waiting",
      "linear",
      ["alice", "bob"],
      "waiting",
      "proj-1",
    );
    pipeStore.grantLease("pipe-1", "alice", "proj-1");
    pipeStore.addPendingPipe("alice", "proj-1", "pipe-waiting");

    const released = pipeStore.markPipeStatus("pipe-1", "failed", "proj-1");
    expect(released).toContain("alice");

    const pending = pipeStore.popPendingPipes("alice", "proj-1");
    expect(pending).toEqual(["pipe-waiting"]);
  });

  it("markPipeStatus releases all leases on terminal status", () => {
    createLinearPipe();
    pipeStore.grantLease("pipe-1", "alice", "proj-1");
    expect(pipeStore.getActiveLease("alice", "proj-1")).toBeDefined();

    pipeStore.markPipeStatus("pipe-1", "failed", "proj-1");
    expect(pipeStore.getActiveLease("alice", "proj-1")).toBeUndefined();

    const pipe = pipeStore.getPipe("pipe-1", "proj-1");
    expect(pipe?.status).toBe("failed");
  });

  it("project isolation: pipes in different projects are independent", () => {
    pipeStore.createPipe(
      "pipe-1",
      "linear",
      ["alice", "bob"],
      "prompt",
      "proj-1",
    );
    pipeStore.createPipe(
      "pipe-1",
      "linear",
      ["alice", "bob"],
      "prompt",
      "proj-2",
    );

    // Grant lease in proj-1
    pipeStore.grantLease("pipe-1", "alice", "proj-1");

    // Can still grant in proj-2 (different project, no conflict)
    const result = pipeStore.grantLease("pipe-1", "alice", "proj-2");
    expect(result.ok).toBe(true);
  });
});

// ── Lease-aware authorization (claude-15) ────────────────────────────────────

describe("pipe-store lease expiry enforcement", () => {
  it("isLeaseExpired returns false when no deadline", () => {
    pipeStore.createPipe(
      "pipe-no-timeout",
      "linear",
      ["alice", "bob"],
      "test",
      "proj-1",
      { stageTimeoutMs: 0 },
    );
    const result = pipeStore.grantLease("pipe-no-timeout", "alice", "proj-1");
    expect(result.ok).toBe(true);
    expect(result.lease!.deadline).toBeNull();
    expect(pipeStore.isLeaseExpired(result.lease!)).toBe(false);
  });

  it("submitStage accepts submission with active lease", () => {
    createLinearPipe();
    pipeStore.grantLease("pipe-1", "alice", "proj-1");
    const result = pipeStore.submitStage(
      "pipe-1",
      "alice",
      "timely output",
      "proj-1",
      true,
    );
    expect(result.ok).toBe(true);
  });
});

describe("pipe-store assignment queries", () => {
  it("getAssignmentsForParticipant returns slots", () => {
    createLinearPipe();
    pipeStore.grantLease("pipe-1", "alice", "proj-1");
    const a = assignmentQueries.getAssignmentsForParticipant("alice", "proj-1");
    expect(a).toHaveLength(1);
    expect(a[0].leaseStatus).toBe("active");
  });

  it("getAssignmentForPipe returns details", () => {
    createLinearPipe();
    pipeStore.grantLease("pipe-1", "alice", "proj-1");
    const a = assignmentQueries.getAssignmentForPipe(
      "pipe-1",
      "alice",
      "proj-1",
    );
    expect(a).toBeDefined();
    expect(a!.leaseStatus).toBe("active");
  });

  it("getAssignmentForPipe returns undefined for non-assignee", () => {
    createLinearPipe();
    expect(
      assignmentQueries.getAssignmentForPipe("pipe-1", "stranger", "proj-1"),
    ).toBeUndefined();
  });
});
