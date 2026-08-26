// TRAJ-01 — 12 successive prose edits and insertions to a quarterly report.
//
// The "boring, healthy" trajectory: corrections, one new list item, one new
// closing paragraph, one new section — the kind of session a real editing
// pass over a report actually looks like. No wrapper divs, no heading
// mischief. This is the baseline the other two scenarios contrast against:
// coherence.mjs should score this one high on every dimension.

const START_DOC = `<article>
<h1>Q3 2026 Platform Reliability Report</h1>
<p class="meta">Prepared by the Platform Engineering team — October 2026.</p>

<h2>Summary</h2>
<p>Uptime for the quarter held at 99.92%, with two Sev-2 incidents and zero Sev-1 incidents. The team shipped 14 deploys per week on average, up from 9 in Q2.</p>

<h2>Incidents</h2>
<ul>
<li>2026-07-14 — checkout latency spike, root cause: connection pool exhaustion, resolved in 38 minutes.</li>
<li>2026-08-22 — background job queue backlog, root cause: a misconfigured retry policy, resolved in 1h12m.</li>
</ul>

<h2>Deployment metrics</h2>
<p>Median deploy time dropped from 11 minutes to 7 minutes after the CI cache change landed in August.</p>

<h2>Roadmap</h2>
<p>Q4 priorities: finish the canary-rollout rework and close out the on-call rotation redesign.</p>
</article>`;

function edit(find, replace) {
  return { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find, replace }] } };
}

const STEPS = [
  {
    prompt: 'Correct the uptime figure to 99.94%.',
    ...edit('99.92%', '99.94%'),
  },
  {
    prompt: 'Note in the summary that there were no customer-visible SLA breaches.',
    ...edit('up from 9 in Q2.', 'up from 9 in Q2. No customer-visible SLA breaches were recorded.'),
  },
  {
    prompt: 'Add the September incident to the incidents list.',
    ...edit(
      '<li>2026-08-22 — background job queue backlog, root cause: a misconfigured retry policy, resolved in 1h12m.</li>',
      '<li>2026-08-22 — background job queue backlog, root cause: a misconfigured retry policy, resolved in 1h12m.</li>\n<li>2026-09-03 — auth token cache stampede, root cause: cold cache after a redeploy, resolved in 22 minutes.</li>',
    ),
  },
  {
    prompt: 'Hyphenate "connection pool" in the first incident.',
    ...edit('connection pool exhaustion', 'connection-pool exhaustion'),
  },
  {
    prompt: 'Update the deploy-time improvement and mention the September follow-up.',
    ...edit(
      'from 11 minutes to 7 minutes after the CI cache change landed in August.',
      'from 11 minutes to 6 minutes after the CI cache change landed in August. A follow-up index change in September shaved another minute off the median.',
    ),
  },
  {
    prompt: 'Add a Cost section before the Roadmap section.',
    ...edit(
      '<h2>Roadmap</h2>',
      '<h2>Cost</h2>\n<p>Compute spend was flat quarter over quarter at $184k, as the deploy-time improvements offset new canary environments.</p>\n\n<h2>Roadmap</h2>',
    ),
  },
  {
    prompt: 'Add a third Q4 priority: migrating the job queue to the new broker.',
    ...edit(
      'finish the canary-rollout rework and close out the on-call rotation redesign.',
      'finish the canary-rollout rework and close out the on-call rotation redesign. A third priority is migrating the job queue to the new broker.',
    ),
  },
  {
    prompt: 'Mark the report metadata line as final.',
    ...edit('October 2026.', 'October 2026 (final).'),
  },
  {
    prompt: 'Note that the first incident was confirmed via postmortem review.',
    ...edit('resolved in 38 minutes.', 'resolved in 38 minutes (confirmed via the postmortem review).'),
  },
  {
    prompt: 'Add a closing paragraph pointing to the postmortem wiki.',
    ...edit(
      'the on-call rotation redesign. A third priority is migrating the job queue to the new broker.</p>',
      'the on-call rotation redesign. A third priority is migrating the job queue to the new broker.</p>\n\n<p>Full incident postmortems are linked from the internal wiki.</p>',
    ),
  },
  {
    prompt: 'Clarify what counts as a Sev-1.',
    ...edit('zero Sev-1 incidents', 'zero Sev-1 incidents (P0)'),
  },
  {
    prompt: 'Expand the closing note on postmortems.',
    ...edit(
      'Full incident postmortems are linked from the internal wiki.',
      'Full incident postmortems, including timeline and mitigation steps, are linked from the internal wiki.',
    ),
  },
];

export default {
  id: 'TRAJ-01',
  description: '12 successive prose corrections/insertions to a quarterly report — the healthy baseline trajectory',
  startDoc: START_DOC,
  steps: STEPS,
};
