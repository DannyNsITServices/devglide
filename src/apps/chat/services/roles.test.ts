import { describe, expect, it } from 'vitest';
import { getRole, listRoles } from './roles.js';

const REQUIRED_SECTION_PATTERNS = [
  /\*\*Primary responsibility:\*\*/,
  /\*\*On assignment, start by:\*\*/,
  /\*\*You may:\*\*/,
  /\*\*Do not:\*\*/,
  /\*\*If assigned off-role work:\*\*/,
  /\*\*Done when:\*\*/,
];

describe('role prompts', () => {
  it('gives every built-in role the required operational sections and an example', () => {
    for (const role of listRoles()) {
      for (const pattern of REQUIRED_SECTION_PATTERNS) {
        expect(role.instructions).toMatch(pattern);
      }
      expect(role.instructions).toContain('Example:');
    }
  });

  it('includes the shared role-boundary language in every built-in role briefing', () => {
    for (const role of listRoles()) {
      expect(role.instructions).toContain('Holding a role alone does not authorize action.');
      expect(role.instructions).toContain('An explicit assignment does not override role boundaries');
      expect(role.instructions).toContain('requested work must be inside your current role scope');
      expect(role.instructions).toContain('If the requested work is outside your role, do not execute it.');
      expect(role.instructions).toContain('If a task mixes in-scope and off-scope work, do only the in-scope part and call out the rest.');
    }
  });

  it('keeps the tech lead focused on delegation instead of direct implementation', () => {
    const role = getRole('tech-lead');
    expect(role).toBeDefined();
    expect(role?.description).toContain('does not implement by default');
    expect(role?.instructions).toContain('do not perform that work yourself while holding Tech Lead');
    expect(role?.instructions).toContain('assign it to the correct role by name');
  });

  it('tech-lead routing matrix maps each task type to exactly one role', () => {
    const inst = getRole('tech-lead')!.instructions;
    // implementation work → implementer
    expect(inst).toContain('Implementation, bug fixes, refactors, and feature code');
    expect(inst).toMatch(/Implementation.*→.*`implementer`/);
    // verification work → tester
    expect(inst).toContain('Verification, test execution, reproduction, and pass/fail evidence');
    expect(inst).toMatch(/Verification.*→.*`tester`/);
    // code review → reviewer (excluding architecture/design)
    expect(inst).toContain('Code review and approval (excluding architecture/design)');
    expect(inst).toMatch(/Code review and approval.*→.*`reviewer`/);
    // architecture/design review stays with tech-lead
    expect(inst).toContain('Architecture review and design-adherence review remain in `tech-lead` scope');
    // role-match prohibition
    expect(inst).toContain('Do not assign work to a participant whose current role does not match the task type');
  });

  it('tech-lead must check availability and prefer idle candidates before delegating', () => {
    const inst = getRole('tech-lead')!.instructions;
    // Must reference chat_members as the source of truth for availability
    expect(inst).toContain('chat_members');
    // Must state the availability-first rule
    expect(inst).toContain('prefer idle/free candidates in the matching role');
    // Must explicitly forbid assigning to a working participant when an idle one exists
    expect(inst).toContain('never assign to a working participant when an idle one in the same role is available');
  });

  it('tech-lead must proactively split broad implementation work across available implementers', () => {
    const inst = getRole('tech-lead')!.instructions;
    // Proactive splitting rule for decomposable work
    expect(inst).toContain('proactively split the work and distribute the disjoint slices across multiple available implementers');
    // Each split slice must be its own by-name assignment with acceptance criteria
    expect(inst).toContain('Make each slice a separate by-name assignment with its own acceptance criteria');
    // Narrow/non-partitionable work must still go to a single owner
    expect(inst).toContain('work that cannot be safely partitioned');
    expect(inst).toContain('assign exactly one named owner');
    expect(inst).toContain('do not force a split');
  });

  it('keeps the implementer inside implementation and unit-test scope', () => {
    const role = getRole('implementer');
    expect(role).toBeDefined();
    expect(role?.description).toContain('supporting unit tests');
    expect(role?.instructions).toContain('Self-approve your own work');
    expect(role?.instructions).toContain('final independent review or testing');
  });

  it('keeps the reviewer from authoring the fix they are reviewing', () => {
    const role = getRole('reviewer');
    expect(role).toBeDefined();
    expect(role?.description).toContain('does not author the fix');
    expect(role?.instructions).toContain('Implement fixes or patch product code as part of the same review assignment');
    expect(role?.instructions).toContain('If assigned implementation work, do not patch it.');
  });

  it('keeps the tester focused on evidence instead of product-code fixes', () => {
    const role = getRole('tester');
    expect(role).toBeDefined();
    expect(role?.description).toContain('does not fix product code by default');
    expect(role?.instructions).toContain('Silently fix product code');
    expect(role?.instructions).toContain('If assigned product implementation work, do not do it.');
  });
});
