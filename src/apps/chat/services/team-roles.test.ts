import { describe, expect, it } from 'vitest';
import { BUILT_IN_ROLES, getRole, isValidRoleSlug, listRoles } from './team-roles.js';

describe('team-roles', () => {
  describe('BUILT_IN_ROLES', () => {
    it('defines exactly the five MVP roles', () => {
      const slugs = BUILT_IN_ROLES.map((r) => r.slug);
      expect(slugs).toEqual(['tech-lead', 'implementer', 'reviewer', 'tester', 'kanban']);
    });

    it('every role has required fields populated', () => {
      for (const role of BUILT_IN_ROLES) {
        expect(role.slug, `${role.slug} slug`).toBeTruthy();
        expect(role.displayName, `${role.slug} displayName`).toBeTruthy();
        expect(role.description, `${role.slug} description`).toBeTruthy();
        expect(role.instructions, `${role.slug} instructions`).toBeTruthy();
        expect(role.allowedActions.length, `${role.slug} allowedActions`).toBeGreaterThan(0);
        expect(role.handoffTargets.length, `${role.slug} handoffTargets`).toBeGreaterThan(0);
      }
    });

    it('handoff targets only reference valid sibling slugs', () => {
      const validSlugs = new Set(BUILT_IN_ROLES.map((r) => r.slug));
      for (const role of BUILT_IN_ROLES) {
        for (const target of role.handoffTargets) {
          expect(validSlugs.has(target), `${role.slug} → ${target}`).toBe(true);
        }
      }
    });

    it('no role lists itself as a handoff target', () => {
      for (const role of BUILT_IN_ROLES) {
        expect(role.handoffTargets).not.toContain(role.slug);
      }
    });
  });

  describe('listRoles', () => {
    it('returns a copy — mutations do not affect BUILT_IN_ROLES', () => {
      const list = listRoles();
      expect(list).toHaveLength(BUILT_IN_ROLES.length);
      (list as unknown[]).push({ slug: 'intruder' });
      expect(BUILT_IN_ROLES).toHaveLength(5);
    });
  });

  describe('getRole', () => {
    it('returns the correct template for each built-in slug', () => {
      for (const role of BUILT_IN_ROLES) {
        const found = getRole(role.slug);
        expect(found).toBeDefined();
        expect(found!.slug).toBe(role.slug);
        expect(found!.displayName).toBe(role.displayName);
      }
    });

    it('returns undefined for an unknown slug', () => {
      expect(getRole('unknown-role')).toBeUndefined();
      expect(getRole('')).toBeUndefined();
    });
  });

  describe('isValidRoleSlug', () => {
    it('returns true for all built-in slugs', () => {
      for (const role of BUILT_IN_ROLES) {
        expect(isValidRoleSlug(role.slug)).toBe(true);
      }
    });

    it('returns false for unknown or empty slugs', () => {
      expect(isValidRoleSlug('unknown')).toBe(false);
      expect(isValidRoleSlug('')).toBe(false);
      expect(isValidRoleSlug('Tech Lead')).toBe(false); // displayName not a valid slug
    });
  });

  describe('role content spot-checks', () => {
    it('tech-lead instructions mention delegation guide', () => {
      expect(getRole('tech-lead')!.instructions).toContain('Delegation guide');
    });

    it('reviewer instructions warn against self-review', () => {
      expect(getRole('reviewer')!.instructions).toContain('must not review work you also authored');
    });

    it('kanban instructions mention never moving to Done', () => {
      expect(getRole('kanban')!.instructions).toContain('Never move items to Done');
    });

    it('implementer instructions require explicit assignment', () => {
      expect(getRole('implementer')!.instructions).toContain('explicitly assigned');
    });

    it('tester instructions require passing review first', () => {
      expect(getRole('tester')!.instructions).toContain('passed Reviewer approval');
    });
  });
});
