/**
 * Parser for /team slash commands.
 *
 * Supported subcommands:
 *   /team create <name> [--mode assist|manual]
 *   /team status
 *   /team edit [--name <name>] [--mode assist|manual]
 *   /team add <roleSlug> @<assignee>
 *   /team remove @<assignee>
 *   /team pause
 *   /team resume
 *   /team disband
 *   /team run <playbook> [: <prompt>]
 *   /team roles
 *   /team proposal approve|reject|dismiss <proposalId>
 */

import type { PlaybookId } from './team-run-store.js';

// ── Result types ──────────────────────────────────────────────────────────────

export type TeamMode = 'manual' | 'assist';

export type TeamSubcommand =
  | { sub: 'create'; name: string; mode: TeamMode }
  | { sub: 'status' }
  | { sub: 'edit'; name?: string; mode?: TeamMode }
  | { sub: 'add'; roleSlug: string; assignee: string }
  | { sub: 'remove'; assignee: string }
  | { sub: 'pause' }
  | { sub: 'resume' }
  | { sub: 'disband' }
  | { sub: 'run'; playbook: PlaybookId; prompt: string }
  | { sub: 'roles' }
  | { sub: 'proposal'; action: 'approve' | 'reject' | 'dismiss'; proposalId: string };

export interface TeamParseError {
  error: string;
}

export type TeamParseResult = TeamSubcommand | TeamParseError;

const VALID_PLAYBOOKS: PlaybookId[] = ['change-request', 'bug-fix', 'custom'];
const VALID_MODES: TeamMode[] = ['manual', 'assist'];

// ── Detection ─────────────────────────────────────────────────────────────────

export function isTeamCommand(body: string): boolean {
  return /^\/team(\s|$)/.test(body.trim());
}

// ── Flag extraction helpers ───────────────────────────────────────────────────

function extractFlag(args: string, flag: string): string | null {
  const re = new RegExp(`--${flag}\\s+(\\S+(?:\\s+\\S+)*?)(?=\\s+--|$)`);
  const m = args.match(re);
  return m ? m[1].trim() : null;
}

function extractNameFlag(args: string): string | null {
  // --name can include spaces until the next flag or end
  const m = args.match(/--name\s+(.+?)(?=\s+--\w|$)/);
  return m ? m[1].trim() : null;
}

function extractModeFlag(args: string): TeamMode | null {
  const m = args.match(/--mode\s+(\S+)/);
  if (!m) return null;
  const v = m[1].toLowerCase() as TeamMode;
  return VALID_MODES.includes(v) ? v : null;
}

// ── Parser ────────────────────────────────────────────────────────────────────

export function parseTeamCommand(body: string): TeamParseResult {
  const trimmed = body.trim();

  const m = trimmed.match(/^\/team(?:\s+([\s\S]+))?$/);
  if (!m) return { error: 'Invalid /team command.' };

  const rest = (m[1] ?? '').trim();

  if (!rest) {
    return { error: 'Missing subcommand. Try /team status, /team create <name>, /team run <playbook>, etc.' };
  }

  if (rest === 'status') return { sub: 'status' };

  const spaceIdx = rest.indexOf(' ');
  const sub = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const argsStr = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();
  const argTokens = argsStr.split(/\s+/).filter(Boolean);

  switch (sub) {
    case 'status':
      return { sub: 'status' };

    case 'roles':
      return { sub: 'roles' };

    case 'pause':
      return { sub: 'pause' };

    case 'resume':
      return { sub: 'resume' };

    case 'disband':
      return { sub: 'disband' };

    case 'create': {
      // /team create <name> [--mode assist|manual]
      // Strip --mode flag from the args, rest is the name
      const modeVal = extractModeFlag(argsStr);
      if (modeVal === null && argsStr.includes('--mode')) {
        return { error: `Invalid --mode value. Use "manual" or "assist".` };
      }
      const namePart = argsStr.replace(/--mode\s+\S+/g, '').trim();
      if (!namePart) return { error: '/team create requires a team name. Usage: /team create <name> [--mode assist|manual]' };
      return { sub: 'create', name: namePart, mode: modeVal ?? 'manual' };
    }

    case 'edit': {
      // /team edit [--name <name>] [--mode assist|manual]
      const modeVal = extractModeFlag(argsStr);
      if (modeVal === null && argsStr.includes('--mode')) {
        return { error: `Invalid --mode value. Use "manual" or "assist".` };
      }
      const nameVal = extractNameFlag(argsStr);
      if (!nameVal && !modeVal) {
        return { error: '/team edit requires at least one of --name <name> or --mode <assist|manual>.' };
      }
      return { sub: 'edit', ...(nameVal ? { name: nameVal } : {}), ...(modeVal ? { mode: modeVal } : {}) };
    }

    case 'add': {
      // /team add <roleSlug> @<assignee>
      if (argTokens.length < 2) {
        return { error: '/team add requires a role and an @assignee. Usage: /team add <role> @<name>' };
      }
      const roleSlug = argTokens[0].toLowerCase();
      const assigneeToken = argTokens[1];
      if (!assigneeToken.startsWith('@')) {
        return { error: `Expected @<assignee> but got "${assigneeToken}". Usage: /team add <role> @<name>` };
      }
      const assignee = assigneeToken.slice(1);
      if (!assignee) return { error: 'Assignee name cannot be empty.' };
      return { sub: 'add', roleSlug, assignee };
    }

    case 'remove': {
      // /team remove @<assignee>
      const token = argTokens[0];
      if (!token) return { error: '/team remove requires @<assignee>. Usage: /team remove @<name>' };
      if (!token.startsWith('@')) {
        return { error: `Expected @<assignee> but got "${token}". Usage: /team remove @<name>` };
      }
      const assignee = token.slice(1);
      if (!assignee) return { error: 'Assignee name cannot be empty.' };
      return { sub: 'remove', assignee };
    }

    case 'run': {
      // /team run <playbook> [: <prompt>]
      if (!argTokens.length) {
        return {
          error: `/team run requires a playbook. Available: ${VALID_PLAYBOOKS.join(', ')}. Usage: /team run <playbook> [: <prompt>]`,
        };
      }
      const playbook = argTokens[0].toLowerCase() as PlaybookId;
      if (!VALID_PLAYBOOKS.includes(playbook)) {
        return {
          error: `Unknown playbook "${playbook}". Available: ${VALID_PLAYBOOKS.join(', ')}.`,
        };
      }
      // Everything after the playbook token, strip optional leading colon
      let promptPart = argTokens.slice(1).join(' ').trim();
      if (promptPart.startsWith(':')) promptPart = promptPart.slice(1).trim();

      if (!promptPart && playbook === 'custom') {
        return { error: '/team run custom requires a prompt. Usage: /team run custom : <description>' };
      }

      const prompt = promptPart || `Run ${playbook} playbook`;
      return { sub: 'run', playbook, prompt };
    }

    case 'proposal': {
      // /team proposal approve|reject|dismiss <proposalId>
      const action = argTokens[0]?.toLowerCase() as 'approve' | 'reject' | 'dismiss';
      const validActions = ['approve', 'reject', 'dismiss'];
      if (!action || !validActions.includes(action)) {
        return { error: `/team proposal requires an action: approve, reject, or dismiss. Usage: /team proposal <action> <id>` };
      }
      const proposalId = argTokens[1];
      if (!proposalId) {
        return { error: `/team proposal ${action} requires a proposal ID.` };
      }
      return { sub: 'proposal', action, proposalId };
    }

    default:
      return {
        error: `Unknown /team subcommand "${sub}". Try: create, status, edit, add, remove, pause, resume, disband, run, roles, proposal.`,
      };
  }
}

export function isTeamParseError(result: TeamParseResult): result is TeamParseError {
  return 'error' in result;
}
