import fs from 'fs';
import type { ShellConfig } from '../../apps/shell/src/shell-types.js';

export type { ShellConfig };

// ── Env helpers ──────────────────────────────────────────────────────────────

const ENV_ALLOWLIST_UNIX: string[] = ['HOME', 'PATH', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK'];

export function safeEnv(extra: Record<string, string> = {}): Record<string, string> {
  // On Windows, pass through the full environment — cmd.exe and PowerShell
  // need many undocumented env vars to initialize properly.
  if (process.platform === 'win32') {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    return { ...env, ...extra };
  }
  const env: Record<string, string> = { TERM: 'xterm-256color' };
  for (const key of ENV_ALLOWLIST_UNIX) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  }
  return { ...env, ...extra };
}

// ── Shell configs ────────────────────────────────────────────────────────────

/** Resolve the user's default shell from $SHELL, falling back to bash (Unix) or cmd (Windows). */
function resolveDefaultShell(): string {
  const userShell = process.env.SHELL;
  if (userShell && fs.existsSync(userShell)) return userShell;
  if (process.platform === 'win32') {
    // Prefer Git Bash if installed — better terminal experience than cmd.exe
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (fs.existsSync(gitBash)) return gitBash;
    return 'cmd.exe';
  }
  return 'bash';
}

export const SHELL_CONFIGS: Record<string, ShellConfig> = {
  default: {
    get command(): string { return resolveDefaultShell(); },
    args: [],
    env: safeEnv()
  },
  bash: {
    command: 'bash',
    args: [],
    env: safeEnv()
  },
  cmd: {
    command: 'cmd.exe',
    args: [],
    env: safeEnv()
  },
  'git-bash': {
    command: 'C:\\Program Files\\Git\\bin\\bash.exe',
    args: [],
    env: safeEnv()
  },
};
