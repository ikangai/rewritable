# API Key Rotation Guide

Rotating an API key safely takes four steps: generate, deploy, verify, and revoke the old key.

## Prerequisites

- Admin access to the dashboard
- A maintenance window of at least 15 minutes
- The `rwa proxy` CLI installed locally

## Steps

1. Generate a new key in the dashboard under Settings > API Keys.
2. Deploy the new key to every service that reads `OPENROUTER_API_KEY`.
3. Verify traffic with the new key using the health check endpoint.
4. Revoke the old key once traffic has fully shifted.

## Rate limits

| Plan | Requests/min | Burst |
|------|---------------|-------|
| Free | 60 | 100 |
| Pro | 600 | 1000 |
| Enterprise | 6000 | 10000 |

## Latency budget

The system diagram below shows the request path from client to origin:

<svg width="200" height="80" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="20" width="60" height="30" fill="#ccc"/>
  <text x="10" y="40">Client</text>
  <line x1="60" y1="35" x2="140" y2="35" stroke="black"/>
  <rect x="140" y="20" width="60" height="30" fill="#ccc"/>
  <text x="150" y="40">Origin</text>
</svg>

Expected round-trip latency follows the relation below:

<math xmlns="http://www.w3.org/1998/Math/MathML">
  <mrow><mi>T</mi><mo>=</mo><mn>2</mn><mo>&#215;</mo><mrow><mo>(</mo><mi>P</mi><mo>+</mo><mi>Q</mi><mo>)</mo></mrow></mrow>
</math>

## Code example

```bash
rwa proxy set-key --stdin
```

Once rotation is complete, confirm the old key returns 401 on the next request.
