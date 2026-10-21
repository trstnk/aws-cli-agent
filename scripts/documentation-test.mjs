#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-documentation-'));
process.env.XDG_CONFIG_HOME = scratch;
process.env.XDG_STATE_HOME = scratch;
process.env.XDG_DATA_HOME = scratch;
// Only the scripted model gets a dummy key. No ambient search/model credentials.
for (const name of Object.keys(process.env)) {
  if (/API_KEY|AUTH_TOKEN|AWS_ACCESS_KEY|AWS_SECRET|AWS_SESSION_TOKEN/.test(name)) delete process.env[name];
}
const { ConfigSchema, loadConfig, writeDefaultConfig } = await import('../dist/config.js');
const { createTools } = await import('../dist/tools/index.js');
const { runAgent } = await import('../dist/agent.js');
const { Logger } = await import('../dist/logger.js');
const { UserCancelledError } = await import('../dist/errors.js');
const originalFetch = globalThis.fetch;
const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
const originalWrite = process.stderr.write;
const entries = [];
const history = { search: () => [], recent: () => [], append: () => {} };
const logger = new Logger('silent');
const audit = { logDocumentation: (entry) => entries.push(entry), logCommand: (entry) => entries.push(entry) };
function config(extra = {}) {
  return ConfigSchema.parse({ provider: 'anthropic', anthropic: { model: 'claude-scripted', apiKey: 'scripted-only' }, ...extra });
}
function tools(cfg = config()) {
  return createTools({ config: cfg, history, audit, logger, record: () => assert.fail('A lookup must not record an AWS command') });
}
const execution = { toolCallId: 'test', messages: [] };
async function answerPrompt(answer, fn) {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  Object.defineProperty(process, 'stdin', { configurable: true, value: input });
  let output = '';
  process.stderr.write = function (chunk, ...args) {
    output += chunk.toString();
    const callback = args.find((arg) => typeof arg === 'function');
    callback?.();
    return true;
  };
  const interval = setInterval(() => {
    if (input.listenerCount('keypress')) input.write(answer);
  }, 15);
  try { return { result: await fn(), output }; }
  finally {
    clearInterval(interval);
    process.stderr.write = originalWrite;
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    input.destroy();
  }
}
function rpcFetch({ callResult, fail, hang, onRequest } = {}) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://search.parallel.ai/mcp');
    const headers = new Headers(init.headers);
    assert.match(headers.get('user-agent'), /^aws-cli-agent .*github.com\/trstnk\/aws-cli-agent/);
    assert.equal(headers.has('authorization'), false);
    assert.equal(init.redirect, 'error');
    if (init.method === 'GET') return new Response('', { status: 405 });
    const request = JSON.parse(init.body);
    requests.push(request);
    onRequest?.(request);
    if (hang === request.method) return new Promise((_, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    if (fail === request.method) return new Response('Service unavailable', { status: 503 });
    if (!('id' in request)) return new Response(null, { status: 202 });
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: ['web_search', 'web_fetch'].map((name) => ({ name, inputSchema: { type: 'object' } })) };
    else if (request.method === 'tools/call') result = callResult ?? { content: [{ type: 'text', text: 'https://docs.aws.amazon.com/cli/latest/reference/s3api/list-buckets.html Use --query to select bucket names.' }] };
    else if (request.method === 'notifications/cancelled') return new Response(null, { status: 202 });
    else assert.fail(`Unexpected method: ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } });
  };
  return requests;
}

test('configuration keeps saved model/AWS choices and disables both tools', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; assert.fail('No request during configuration or tool construction'); };
  const file = writeDefaultConfig();
  assert.deepEqual(loadConfig().search, { enabled: true, timeoutMs: 15000 });
  const saved = { provider: 'openai', openai: { model: 'saved-model', apiKeyEnv: 'MY_SAVED_KEY' }, autoApprove: { readOnly: false, all: false }, search: { enabled: false, timeoutMs: 2000 } };
  fs.writeFileSync(file, JSON.stringify(saved));
  writeDefaultConfig();
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), saved);
  const loaded = loadConfig();
  assert.equal(loaded.openai.model, 'saved-model');
  assert.equal(loaded.openai.apiKeyEnv, 'MY_SAVED_KEY');
  assert.equal(loaded.autoApprove.readOnly, false);
  assert.ok(!('search_aws_documentation' in tools(loaded)));
  assert.ok(!('fetch_aws_documentation' in tools(loaded)));
  assert.ok('search_aws_documentation' in tools(config()));
  assert.equal(requests, 0);
  assert.equal(ConfigSchema.safeParse({ search: { timeoutMs: 0 } }).success, false);
});

test('declining a lookup prevents all MCP requests even with AWS auto-approve', async () => {
  const requests = rpcFetch();
  const { result, output } = await answerPrompt('\n', () => tools(config({ autoApprove: { all: true } })).search_aws_documentation.execute({ query: 's3 list-buckets' }, execution));
  assert.equal(result.ok, false);
  assert.match(result.content, /declined/);
  assert.match(output, /s3 list-buckets/);
  assert.equal(requests.length, 0);
});

test('registered search and fetch construct anonymous MCP calls with a stable run session', async () => {
  const requests = rpcFetch();
  const registered = tools();
  const search = await answerPrompt('y\n', () => registered.search_aws_documentation.execute({ query: 's3 list-buckets query' }, execution));
  assert.equal(search.result.ok, true);
  assert.match(search.result.content, /https:\/\/docs.aws.amazon.com/);
  const url = 'https://docs.aws.amazon.com/cli/latest/reference/s3api/list-buckets.html';
  const fetched = await answerPrompt('y\n', () => registered.fetch_aws_documentation.execute({ url }, execution));
  assert.equal(fetched.result.ok, true);
  assert.match(fetched.output, /docs.aws.amazon.com/);
  const calls = requests.filter((r) => r.method === 'tools/call');
  assert.equal(calls[0].params.name, 'web_search');
  assert.deepEqual(calls[0].params.arguments.search_queries, ['site:docs.aws.amazon.com s3 list-buckets query']);
  assert.equal(calls[1].params.name, 'web_fetch');
  assert.deepEqual(calls[1].params.arguments.urls, [url]);
  assert.match(calls[0].params.arguments.session_id, /^[a-f0-9-]{36}$/);
  assert.equal(calls[0].params.arguments.session_id, calls[1].params.arguments.session_id);
  assert.equal(requests.filter((r) => r.method === 'tools/list').length, 2);
  assert.ok(entries.some((e) => e.action === 'search' && e.ok));
  assert.ok(entries.some((e) => e.action === 'fetch' && e.ok));
});

test('fetch rejects non-AWS, insecure, credentialed and misleading URLs without network', async () => {
  const requests = rpcFetch();
  const tool = tools().fetch_aws_documentation;
  for (const url of ['http://docs.aws.amazon.com/x', 'https://example.com', 'https://docs.aws.amazon.com.evil.test/', 'https://secret@docs.aws.amazon.com/x', 'https://docs.aws.amazon.com:8443/x', 'file:///etc/passwd', 'not a URL']) {
    assert.equal(tool.inputSchema.safeParse({ url }).success, false, url);
    assert.equal((await tool.execute({ url }, execution)).ok, false, url);
  }
  assert.equal(requests.length, 0);
});

test('remote errors, MCP errors and malformed responses are useful failures without fallback', async () => {
  for (const options of [{ fail: 'initialize' }, { callResult: { isError: true, content: [{ type: 'text', text: 'Lookup unavailable' }] } }, { callResult: { content: 'invalid' } }]) {
    const requests = rpcFetch(options);
    const { result } = await answerPrompt('y\n', () => tools().search_aws_documentation.execute({ query: 'ec2 describe-instances' }, execution));
    assert.equal(result.ok, false);
    assert.ok(result.content);
    assert.ok(requests.filter((r) => r.method === 'tools/call').length <= 1);
  }
});

test('Ctrl-C and caller cancellation during approval make no network request', async () => {
  const requests = rpcFetch();
  await assert.rejects(answerPrompt('\u0003', () => tools().search_aws_documentation.execute({ query: 's3 list-buckets' }, execution)), UserCancelledError);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(answerPrompt('', () => tools().search_aws_documentation.execute({ query: 's3 list-buckets' }, { ...execution, abortSignal: controller.signal })), UserCancelledError);
  } finally { clearTimeout(timer); }
  assert.equal(requests.length, 0);
});

test('total timeout aborts discovery and removes SIGINT listeners', async () => {
  const listeners = process.listenerCount('SIGINT');
  rpcFetch({ hang: 'initialize' });
  const started = Date.now();
  const { result } = await answerPrompt('y\n', () => tools(config({ search: { timeoutMs: 1000 } })).search_aws_documentation.execute({ query: 'ec2 describe-instances' }, execution));
  assert.equal(result.ok, false);
  assert.match(result.content, /timed out/);
  assert.ok(Date.now() - started < 3000);
  assert.equal(process.listenerCount('SIGINT'), listeners);
});

test('caller cancellation and Ctrl-C abort an in-flight call; pre-aborted calls never prompt', async () => {
  const controller = new AbortController();
  let requests = rpcFetch({ hang: 'tools/call', onRequest: (request) => { if (request.method === 'tools/call') setTimeout(() => controller.abort(), 10); } });
  await assert.rejects(answerPrompt('y\n', () => tools().search_aws_documentation.execute({ query: 's3 list-buckets' }, { ...execution, abortSignal: controller.signal })), UserCancelledError);
  assert.equal(requests.filter((r) => r.method === 'tools/call').length, 1);
  requests = rpcFetch();
  await assert.rejects(tools().search_aws_documentation.execute({ query: 's3 list-buckets' }, { ...execution, abortSignal: controller.signal }), UserCancelledError);
  assert.equal(requests.length, 0);
  rpcFetch({ hang: 'tools/call', onRequest: (request) => { if (request.method === 'tools/call') setTimeout(() => process.emit('SIGINT'), 10); } });
  await assert.rejects(answerPrompt('y\n', () => tools().search_aws_documentation.execute({ query: 's3 list-buckets' }, execution)), UserCancelledError);
});

function anthropicStream(toolName, input, id) {
  const events = [
    { type: 'message_start', message: { id: `msg-${id}`, type: 'message', role: 'assistant', content: [], model: 'claude-scripted', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    ...(toolName ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: toolName, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    ] : [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Documentation received.' } },
    ]),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: toolName ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

test('scripted model drives the real runAgent dispatcher and consumes search/fetch results', async () => {
  const requests = rpcFetch();
  const mcpFetch = globalThis.fetch;
  const modelRequests = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://search.parallel.ai/mcp') return mcpFetch(url, init);
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(init.body);
    modelRequests.push(body);
    if (modelRequests.length === 1) {
      assert.ok(body.tools.some((t) => t.name === 'search_aws_documentation'));
      return anthropicStream('search_aws_documentation', { query: 's3api list-buckets query' }, 'search-1');
    }
    const serialized = JSON.stringify(body.messages);
    assert.match(serialized, /Use --query to select bucket names/);
    if (modelRequests.length === 2) return anthropicStream('fetch_aws_documentation', { url: 'https://docs.aws.amazon.com/cli/latest/reference/s3api/list-buckets.html' }, 'fetch-1');
    assert.match(serialized, /fetch-1/);
    if (modelRequests.length === 3) return anthropicStream('execute_aws_command', { args: ['s3api', 'list-buckets', '--query', 'Buckets[].Name'], purpose: 'List bucket names using the documented query option' }, 'aws-1');
    assert.match(serialized, /fixture-bucket/);
    return anthropicStream(null, null, 'done');
  };
  const previousPath = process.env.PATH;
  const bin = path.join(scratch, 'aws');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf 'fixture-bucket\\n'\n`, { mode: 0o700 });
  process.env.PATH = `${scratch}${path.delimiter}${previousPath}`;
  const { result } = await answerPrompt('y\n', () => runAgent({
    input: 'Prepare an AWS CLI bucket listing after checking current documentation', config: config(), logger, history, audit,
    reasoning: { beginRun() {}, echoToolCall() {}, echoReasoning() {}, logStepToFile() {} },
    usage: { log() {} },
  }));
  process.env.PATH = previousPath;
  assert.equal(modelRequests.length, 4);
  assert.equal(requests.filter((r) => r.method === 'tools/call').length, 2);
  assert.equal(result.steps, 4);
  assert.equal(result.executedCommandCount, 1);
  assert.equal(result.finalOutput, 'fixture-bucket\n');
  assert.equal(result.commands.length, 1);
  assert.match(result.commands[0], /s3api list-buckets/);
});

test.after(() => {
  globalThis.fetch = originalFetch;
  logger.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});
