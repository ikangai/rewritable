// TRAJ-03 — a knowledge-base article that grows one section at a time, the
// way a real doc accretes over a dozen "add a note about X" edits. Some
// additions land at the right heading depth; others jump straight to a
// sub-sub-heading to save a round trip, and two more top-level sections get
// bolted on alongside the original h1. No single edit is malformed on its
// own (each is one clean insertion at a unique anchor) — the outline only
// looks wrong once you read the END doc's heading sequence as a whole. This
// is the shape coherence.mjs's `headings` dimension exists to catch.

const START_DOC = `<article>
<h1>Deploying the Edge Cache</h1>
<p>This guide walks through provisioning, configuring, and rolling out the edge cache tier.</p>

<h2>Provisioning</h2>
<p>Request a new node pool via the infra console and tag it edge-cache.</p>
</article>`;

// { level, title, body, prompt } — appended in order, each right after the
// previous addition's paragraph (see buildSteps).
const ADDITIONS = [
  { level: 2, title: 'Configuration', body: 'Set the TTL and eviction policy in cache.yaml before the first deploy.', prompt: 'Add a Configuration section.' },
  { level: 3, title: 'Cache TTLs', body: 'Static assets default to 24h; API responses default to 60s.', prompt: 'Add a Cache TTLs subsection under Configuration.' },
  { level: 2, title: 'Rollout', body: 'Roll out to one region first, watch error rates for 30 minutes, then proceed.', prompt: 'Add a Rollout section.' },
  { level: 4, title: 'Canary steps', body: 'Shift 5% of traffic, then 25%, then 100%, pausing 10 minutes between each.', prompt: 'Add the canary steps as a quick sub-sub-heading under Rollout.' },
  { level: 1, title: 'Deploying the Edge Cache — Addendum', body: 'The steps below cover an edge case introduced in the September release.', prompt: 'Start a new top-level addendum section for the September edge case.' },
  { level: 3, title: 'Rollback', body: 'Revert the node pool tag and redeploy the previous cache.yaml.', prompt: 'Add a Rollback subsection.' },
  { level: 5, title: 'Emergency rollback', body: 'Page the on-call SRE and use the break-glass script.', prompt: 'Add an emergency rollback note nested under Rollback.' },
  { level: 2, title: 'Monitoring', body: 'Watch cache hit ratio and origin request volume on the edge-cache dashboard.', prompt: 'Add a Monitoring section back at the top level.' },
  { level: 1, title: 'Glossary', body: 'TTL: time to live. Eviction: removing an entry before its TTL expires.', prompt: 'Add a glossary as its own top-level section.' },
  { level: 6, title: 'Glossary source', body: 'Terms are pulled from the platform-wide glossary doc.', prompt: 'Add a tiny sourcing note under the glossary.' },
  { level: 2, title: 'FAQ', body: 'Why not cache POST responses? They are not idempotent by default.', prompt: 'Add an FAQ section.' },
  { level: 4, title: 'FAQ follow-ups', body: 'Follow-up questions get triaged into the next doc revision.', prompt: 'Add an FAQ follow-ups note, jumping straight to a sub-sub-heading.' },
];

function buildSteps() {
  const steps = [];
  let anchor = 'Request a new node pool via the infra console and tag it edge-cache.</p>';
  for (const a of ADDITIONS) {
    const block = `\n\n<h${a.level}>${a.title}</h${a.level}>\n<p>${a.body}</p>`;
    steps.push({
      prompt: a.prompt,
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [{ find: anchor, replace: anchor + block }] },
    });
    anchor = `<p>${a.body}</p>`; // this step's own new tail — unique, verbatim in the doc after applying
  }
  return steps;
}

export default {
  id: 'TRAJ-03',
  description: '12 successive section insertions into a KB article, drifting from a clean outline into level jumps and duplicate h1s — the outline-drift shape',
  startDoc: START_DOC,
  steps: buildSteps(),
};
