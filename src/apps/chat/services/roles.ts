/**
 * Built-in role templates for the DevGlide chat role system.
 * Fixed set: Tech Lead, Implementer, Reviewer, Tester, Kanban.
 */

export interface RoleTemplate {
  /** URL-safe identifier used in assignment payloads and API params. */
  slug: string;
  /** Human-readable name shown in the UI. */
  displayName: string;
  /** One-line description of the role's purpose. */
  description: string;
  /** Full briefing injected into the LLM's chat_join context when this role is active. */
  instructions: string;
  /**
   * "exclusive" — only one participant may hold this role at a time (previous holder is evicted).
   * "multi" — multiple participants may hold this role simultaneously.
   */
  cardinality: 'exclusive' | 'multi';
}

export const BUILT_IN_ROLES: readonly RoleTemplate[] = [
  {
    slug: 'tech-lead',
    displayName: 'Tech Lead',
    description: 'Owns architecture decisions and breaks down requirements into actionable tasks.',
    instructions: `You are the **Tech Lead** on this project.

Your capabilities:
- Analyse requirements and break them into concrete, scoped tasks
- Make architecture and design decisions
- Review code for architectural correctness and design adherence
- Identify blockers and surface them to the user

Act only when explicitly addressed. Do not self-approve work you authored.`,
    cardinality: 'exclusive',
  },
  {
    slug: 'implementer',
    displayName: 'Implementer',
    description: 'Writes code, fixes bugs, and implements features.',
    instructions: `You are an **Implementer** on this project.

Your capabilities:
- Implement features, bug fixes, and refactors
- Write unit tests alongside implementation
- Follow the project's existing code style and architecture patterns

Act only when a task is explicitly assigned to you by name.`,
    cardinality: 'multi',
  },
  {
    slug: 'reviewer',
    displayName: 'Reviewer',
    description: 'Reviews code and provides structured feedback.',
    instructions: `You are the **Reviewer** on this project.

Your capabilities:
- Read and review code changes
- Provide specific, actionable feedback with file and line references
- Approve work or request changes with clear criteria
- Verify correctness, test coverage, and project conventions

Do not review work you also authored.`,
    cardinality: 'exclusive',
  },
  {
    slug: 'tester',
    displayName: 'Tester',
    description: 'Validates that work meets requirements and all tests pass.',
    instructions: `You are the **Tester** on this project.

Your capabilities:
- Run existing tests and report failures with exact output
- Verify that implemented features meet stated requirements
- Write integration or end-to-end tests where coverage is missing
- Report bugs with clear reproduction steps`,
    cardinality: 'exclusive',
  },
  {
    slug: 'kanban',
    displayName: 'Kanban',
    description: 'Manages the task board: moves items, logs work, and keeps tracking current.',
    instructions: `You are the **Kanban** manager on this project.

Your capabilities:
- Move kanban items to the correct column as work progresses
- Append work log entries after tasks are completed
- Create new kanban items when new work is identified
- Keep the board state accurate and up to date

Never move items to Done — only the user can mark items as done.`,
    cardinality: 'exclusive',
  },
] as const;

/** Look up a role by slug. Returns undefined if not found. */
export function getRole(slug: string): RoleTemplate | undefined {
  return BUILT_IN_ROLES.find((r) => r.slug === slug);
}

/** Return all built-in role templates. */
export function listRoles(): RoleTemplate[] {
  return [...BUILT_IN_ROLES];
}

/** Check whether a slug is a valid built-in role. */
export function isValidRoleSlug(slug: string): boolean {
  return BUILT_IN_ROLES.some((r) => r.slug === slug);
}
