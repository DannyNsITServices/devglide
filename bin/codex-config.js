/**
 * Remove all DevGlide MCP sections from Codex TOML content.
 * This includes the current devglide-* registrations and the legacy bare
 * [mcp_servers.devglide] HTTP entry.
 */
export function removeDevglideSectionsFromToml(toml) {
  const lines = toml.split('\n');
  const result = [];
  let skipping = false;

  for (const line of lines) {
    if (/^\[/.test(line)) {
      skipping = /^\[mcp_servers\.devglide(?:\]|[.-])/.test(line);
    }

    if (!skipping) {
      result.push(line);
    }
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}
