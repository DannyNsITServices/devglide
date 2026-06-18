#!/usr/bin/env node
// Open a release PR to main and enable auto-merge — without the gh CLI, which is not
// installed on the self-hosted runner. Uses the REST API to create the PR and the GraphQL
// API to enable auto-merge. Relies only on Node's global fetch (Node >= 22).
//
// Required env: GH_TOKEN, GITHUB_REPOSITORY (owner/repo), VERSION, RELEASE_BRANCH.

const token = process.env.GH_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const version = process.env.VERSION;
const branch = process.env.RELEASE_BRANCH;

for (const [k, v] of Object.entries({ GH_TOKEN: token, GITHUB_REPOSITORY: repo, VERSION: version, RELEASE_BRANCH: branch })) {
  if (!v) {
    console.error(`::error::Missing required env ${k}`);
    process.exit(1);
  }
}

const [owner, name] = repo.split('/');

async function rest(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

const prBody =
  `Automated version bump for v${version}. Tag \`v${version}\` and the npm publish already ` +
  `completed; merging this lands the bumped package.json on main.`;

// Create the PR — or reuse an existing one for this branch (idempotent on re-run).
let { status, body } = await rest(`/repos/${owner}/${name}/pulls`, {
  method: 'POST',
  body: JSON.stringify({ title: `release: v${version}`, head: branch, base: 'main', body: prBody }),
});

let pr;
if (status === 201) {
  pr = body;
} else {
  // 422 typically means a PR already exists for this head — find and reuse it.
  const existing = await rest(`/repos/${owner}/${name}/pulls?head=${owner}:${branch}&state=open`);
  if (existing.status === 200 && Array.isArray(existing.body) && existing.body.length > 0) {
    pr = existing.body[0];
    console.log(`Reusing existing PR #${pr.number}`);
  } else {
    console.error(`::error::Failed to create PR (HTTP ${status}): ${JSON.stringify(body)}`);
    process.exit(1);
  }
}

console.log(`PR #${pr.number}: ${pr.html_url}`);

// Enable auto-merge (squash) so it lands once required checks/approvals pass.
const result = await graphql(
  `mutation($id: ID!) {
     enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) {
       pullRequest { number }
     }
   }`,
  { id: pr.node_id },
);

if (result.errors?.length) {
  console.log(
    `::warning::Could not enable auto-merge for PR #${pr.number}: ${result.errors.map((e) => e.message).join('; ')}. ` +
    `Ensure "Allow auto-merge" is enabled in repo settings. The PR is open for manual merge.`,
  );
} else {
  console.log(`Auto-merge (squash) enabled for PR #${pr.number}.`);
}
