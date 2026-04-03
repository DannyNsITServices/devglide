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
