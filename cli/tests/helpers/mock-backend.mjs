// Mock OpenAI-compatible /chat/completions server for agent-loop tests.
//
// Returns scripted responses in order; once the script is exhausted, replays
// the last entry so a single-element array can simulate "always replies the
// same". Captures parsed request bodies AND raw headers per call so tests can
// assert on Authorization, model id, message sequencing, etc.

import { createServer } from 'node:http';

/**
 * Start a mock OpenAI-compatible /chat/completions server.
 *
 * @param {Array<{tool_calls?: Array, content?: string}>} responses
 *   Each entry becomes the `choices[0].message` of one completion (with role
 *   'assistant' injected). `finish_reason` is derived: 'tool_calls' if
 *   tool_calls present, else 'stop'.
 *
 * @returns {Promise<{
 *   baseUrl: string,
 *   requests: Array<object>,        // parsed JSON bodies
 *   headers:  Array<object>,        // raw headers for each call
 *   stop:     () => Promise<void>
 * }>}
 */
export function startMockBackend(responses) {
  let cursor = 0;
  const requests = [];
  const headers = [];
  const server = createServer((req, res) => {
    if (req.url !== '/chat/completions' || req.method !== 'POST') {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      headers.push(req.headers);
      try { requests.push(JSON.parse(body)); } catch { requests.push({ raw: body }); }
      const next = responses[Math.min(cursor, responses.length - 1)];
      cursor++;
      const completion = {
        id: 'mock-' + Date.now(),
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', ...next },
          finish_reason: next.tool_calls ? 'tool_calls' : 'stop'
        }]
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(completion));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        headers,
        stop: () => new Promise(r => server.close(r))
      });
    });
  });
}
