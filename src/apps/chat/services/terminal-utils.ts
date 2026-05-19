/**
 * Shared terminal text helpers for PTY output analysis.
 * Used by both chat-registry (prompt watcher / status tracking) and
 * the chat router (shell readiness detection for invite).
 */

/** Regex to strip ANSI escape sequences and carriage returns from terminal output. */
export const STRIP_ANSI_RE = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g;

/** Strip ANSI escape sequences and carriage returns from text. */
export function stripAnsi(str: string): string {
  return str.replace(STRIP_ANSI_RE, '');
}

/** Matches common shell prompt endings: $, #, %, >, ⚡ */
export const SHELL_PROMPT_RE = /[>$#%⚡]\s*$/m;

/** Returns true if text contains a shell prompt after ANSI stripping. */
export function hasShellPrompt(text: string): boolean {
  return SHELL_PROMPT_RE.test(stripAnsi(text));
}
