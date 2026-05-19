function normalizeQuery(query) {
  return (query ?? '').toLowerCase();
}

function startsWithQuery(name, query) {
  return name.toLowerCase().startsWith(normalizeQuery(query));
}

function isLiveLlm(member) {
  return member?.kind === 'llm' && !member.detached && !!member.paneId;
}

function shouldSuggestAll(query) {
  return startsWithQuery('all', query);
}

export function getPipeAssigneeMatches(members, query = '') {
  return members
    .filter(isLiveLlm)
    .filter(member => startsWithQuery(member.name, query))
    .map(member => member.name);
}

export function getMentionMatches(members, query = '') {
  const matches = members
    .filter(member => member?.name !== 'user')
    .filter(member => member && !member.detached)
    .filter(member => member.kind !== 'llm' || !!member.paneId)
    .filter(member => startsWithQuery(member.name, query))
    .map(member => member.name);

  return shouldSuggestAll(query) ? ['all', ...matches] : matches;
}

/** Build the dashboard message header string for a chat message.
 *  Renders `@sender` alone when there are no recipients, `@sender → @target`
 *  for one recipient, `@sender → @t1, @t2` for multiple, and `@user → @all`
 *  for a broadcast. Accepts the persisted `msg.to` value (a comma-separated
 *  string from chat-registry, or `'all'` for broadcasts, or null/empty). */
export function formatRecipientHeader(from, to) {
  const senderRaw = from ?? '';
  const senderTag = senderRaw.startsWith('@') ? senderRaw : `@${senderRaw}`;
  if (to == null || to === '') return senderTag;
  const targets = String(to)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (targets.length === 0) return senderTag;
  const targetTags = targets
    .map(t => (t.startsWith('@') ? t : `@${t}`))
    .join(', ');
  return `${senderTag} \u2192 ${targetTags}`;
}
