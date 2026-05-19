import { describe, expect, it } from "vitest";

import { removeDevglideSectionsFromToml } from "./codex-config.js";

describe("removeDevglideSectionsFromToml", () => {
  it("removes the legacy bare devglide HTTP section", () => {
    const toml = [
      '[windows]',
      'sandbox = "unelevated"',
      '',
      '[mcp_servers.devglide]',
      'url = "http://localhost:7000/mcp"',
      '',
      '[mcp_servers.other]',
      'url = "http://example.com/mcp"',
      '',
    ].join('\n');

    expect(removeDevglideSectionsFromToml(toml)).toBe([
      '[windows]',
      'sandbox = "unelevated"',
      '',
      '[mcp_servers.other]',
      'url = "http://example.com/mcp"',
      '',
    ].join('\n'));
  });

  it("removes devglide server sections together with nested tool overrides", () => {
    const toml = [
      '[mcp_servers.devglide-shell]',
      'command = "node"',
      '',
      '[mcp_servers.devglide-shell.tools.shell_run_command]',
      'approval_mode = "approve"',
      '',
      '[mcp_servers.devglide-chat]',
      'command = "node"',
      '',
      '[mcp_servers.keep]',
      'command = "node"',
      '',
    ].join('\n');

    expect(removeDevglideSectionsFromToml(toml)).toBe([
      '[mcp_servers.keep]',
      'command = "node"',
      '',
    ].join('\n'));
  });
});
