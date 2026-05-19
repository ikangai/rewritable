import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runAgentLoop, AgentError } from '../src/agent-loop.mjs';

test('happy path — model emits valid apply_edits on first try', async () => {
  const { baseUrl, stop, requests } = await startMockBackend([{
    tool_calls: [{
      id: 'c1', type: 'function',
      function: {
        name: 'apply_edits',
        arguments: JSON.stringify({
          version: 'rwa-edit/1',
          edits: [{ find: 'Old', replace: 'New' }],
        }),
      },
    }],
  }]);
  try {
    const result = await runAgentLoop({
      systemPrompt: 'You edit HTML documents.',
      toolSchemas: [{
        type: 'function',
        function: { name: 'apply_edits', description: '...', parameters: { type: 'object' } },
      }],
      currentDoc: '<article>Old</article>',
      instruction: 'change Old to New',
      backend: { baseUrl, model: 'mock', apiKey: 'test' },
    });
    assert.equal(result.toolName, 'apply_edits');
    assert.equal(result.envelope.edits[0].find, 'Old');
    assert.equal(result.envelope.edits[0].replace, 'New');
    // Verify the model received the expected payload.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'mock');
    assert.ok(Array.isArray(requests[0].messages));
    assert.equal(requests[0].messages[0].role, 'system');
    assert.match(requests[0].messages[1].content, /Old/);
    assert.match(requests[0].messages[1].content, /change Old to New/);
  } finally { await stop(); }
});

test('retry exhaustion — 3 invalid responses → no_envelope_after_retries', async () => {
  const { baseUrl, stop, requests } = await startMockBackend([
    { content: 'I cannot do that' },
    { content: 'Still cannot' },
    { content: 'No way' },
  ]);
  try {
    await assert.rejects(
      runAgentLoop({
        systemPrompt: 'test', toolSchemas: [], currentDoc: '<article>x</article>',
        instruction: 'whatever',
        backend: { baseUrl, model: 'mock', apiKey: 'test' },
      }),
      err => err instanceof AgentError && err.subcode === 'no_envelope_after_retries',
    );
    assert.equal(requests.length, 3);
  } finally { await stop(); }
});

test('retry on first failure — second attempt succeeds', async () => {
  const { baseUrl, stop, requests } = await startMockBackend([
    { content: 'I forgot to use the tool' },
    {
      tool_calls: [{
        id: 'c1', type: 'function',
        function: {
          name: 'apply_edits',
          arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'x', replace: 'y' }] }),
        },
      }],
    },
  ]);
  try {
    const retries = [];
    const result = await runAgentLoop({
      systemPrompt: 'test', toolSchemas: [], currentDoc: '<article>x</article>',
      instruction: 'change x to y',
      backend: { baseUrl, model: 'mock', apiKey: 'test' },
      onRetry: r => retries.push(r),
    });
    assert.equal(result.envelope.edits[0].find, 'x');
    assert.equal(retries.length, 1);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].reason, 'no_tool_call');
    assert.equal(requests.length, 2);
    const secondAttemptMessages = requests[1].messages;
    assert.ok(secondAttemptMessages.some(
      m => m.role === 'assistant' && m.content && m.content.includes('I forgot'),
    ));
    assert.ok(secondAttemptMessages.some(
      m => m.role === 'user' && /Retry/i.test(m.content || ''),
    ));
  } finally { await stop(); }
});

test('retry on invalid JSON in tool arguments', async () => {
  const { baseUrl, stop, requests } = await startMockBackend([
    {
      tool_calls: [{
        id: 'c1', type: 'function',
        function: { name: 'apply_edits', arguments: '{this is not json' },
      }],
    },
    {
      tool_calls: [{
        id: 'c2', type: 'function',
        function: {
          name: 'apply_edits',
          arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'x', replace: 'y' }] }),
        },
      }],
    },
  ]);
  try {
    const retries = [];
    const result = await runAgentLoop({
      systemPrompt: 'test', toolSchemas: [], currentDoc: '<article>x</article>',
      instruction: 'change x to y',
      backend: { baseUrl, model: 'mock', apiKey: 'test' },
      onRetry: r => retries.push(r),
    });
    assert.equal(result.envelope.edits[0].find, 'x');
    assert.equal(retries.length, 1);
    assert.equal(retries[0].reason, 'invalid_json');
    assert.equal(retries[0].toolName, 'apply_edits');
    // The retry attempt should include a tool-role message echoing the bad
    // call's id (OpenAI-compatible tool_result pattern).
    const secondAttemptMessages = requests[1].messages;
    assert.ok(secondAttemptMessages.some(
      m => m.role === 'tool' && m.tool_call_id === 'c1' && /Invalid JSON/i.test(m.content || ''),
    ));
  } finally { await stop(); }
});

test('backend HTTP error throws AgentError with backend_error', async () => {
  const server = createServer((req, res) => {
    res.writeHead(500); res.end('boom');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(
      runAgentLoop({
        systemPrompt: 't', toolSchemas: [], currentDoc: 'x',
        instruction: 'y',
        backend: { baseUrl, model: 'm', apiKey: 'k' },
      }),
      err => err instanceof AgentError && err.subcode === 'backend_error',
    );
  } finally { await new Promise(r => server.close(r)); }
});

test('Authorization header sent when apiKey provided', async () => {
  const { baseUrl, stop, headers } = await startMockBackend([{
    tool_calls: [{
      id: 'c1', type: 'function',
      function: {
        name: 'apply_edits',
        arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [] }),
      },
    }],
  }]);
  try {
    await runAgentLoop({
      systemPrompt: 't', toolSchemas: [], currentDoc: 'x',
      instruction: 'y',
      backend: { baseUrl, model: 'm', apiKey: 'secret-123' },
    });
    assert.equal(headers.length, 1);
    assert.equal(headers[0].authorization, 'Bearer secret-123');
  } finally { await stop(); }
});

test('onRetry is optional — no callback works fine', async () => {
  const { baseUrl, stop } = await startMockBackend([
    { content: 'oops' },
    {
      tool_calls: [{
        id: 'c1', type: 'function',
        function: {
          name: 'apply_edits',
          arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: 'x', replace: 'y' }] }),
        },
      }],
    },
  ]);
  try {
    const result = await runAgentLoop({
      systemPrompt: 't', toolSchemas: [], currentDoc: 'x',
      instruction: 'y',
      backend: { baseUrl, model: 'm', apiKey: 'k' },
      // no onRetry
    });
    assert.equal(result.envelope.edits[0].find, 'x');
  } finally { await stop(); }
});
