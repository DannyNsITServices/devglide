import fs from 'fs';
import type { ShellConfig } from '../shell-types.js';

export type { ShellConfig };

const ENV_ALLOWLIST_UNIX = ['HOME', 'PATH', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK'];

/** Absolute shells tried, in order, when $SHELL is unset/missing. zsh is the macOS default since Catalina. */
const UNIX_SHELL_CANDIDATES = ['/bin/zsh', '/bin/bash', '/bin/sh', '/usr/bin/zsh', '/usr/bin/bash', '/usr/bin/sh'];

/** Conservative default PATH for spawn envs launched without one (daemon/GUI launch). */
const DEFAULT_UNIX_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * Ensure a spawn env has a PATH. A macOS daemon or GUI-launched process can have a sparse
 * environment with no PATH; without it node-pty's posix_spawnp cannot locate a bare command
 * and fails. Pure/testable — does not read process.env.
 */
export function withDefaultPath(env: Record<string, string>): Record<string, string> {
  if (env.PATH) return env;
  return { ...env, PATH: DEFAULT_UNIX_PATH };
}

/**
 * Resolve a macOS/Linux shell to an ABSOLUTE path. Returning a bare name ("bash") makes
 * posix_spawnp depend on PATH being present in the child env, which fails under daemon/GUI
 * launch. Pure/testable — caller injects the existence check and $SHELL value.
 */
export function pickUnixShell(exists: (p: string) => boolean, shellEnv: string | undefined): string {
  if (shellEnv && exists(shellEnv)) return shellEnv;
  for (const sh of UNIX_SHELL_CANDIDATES) {
    if (exists(sh)) return sh;
  }
  return '/bin/sh';
}

/** True when a file mode has no execute bit set for any of user/group/other. */
export function lacksExecuteBit(mode: number): boolean {
  return (mode & 0o111) === 0;
}

export function safeEnv(extra: Record<string, string> = {}): Record<string, string> {
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
  return withDefaultPath({ ...env, ...extra });
}

function resolveDefaultShell(): string {
  if (process.platform === 'win32') {
    const userShell = process.env.SHELL;
    if (userShell && fs.existsSync(userShell)) return userShell;
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (fs.existsSync(gitBash)) return gitBash;
    return 'cmd.exe';
  }
  return pickUnixShell(fs.existsSync, process.env.SHELL);
}

export const SHELL_CONFIGS: Record<string, ShellConfig> = {
  default: {
    get command(): string {
      return resolveDefaultShell();
    },
    args: [],
    env: safeEnv(),
  },
  bash: {
    command: 'bash',
    args: [],
    env: safeEnv(),
  },
  cmd: {
    command: 'cmd.exe',
    args: [],
    env: safeEnv(),
  },
  'git-bash': {
    command: 'C:\\Program Files\\Git\\bin\\bash.exe',
    args: [],
    env: safeEnv(),
  },
};
