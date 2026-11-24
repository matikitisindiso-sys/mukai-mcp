// End-to-end approval + security tests against a REAL Mukai backend.
//
// Needs: a running Mukai backend, test/mock-llm.mjs on 127.0.0.1:11434, and this
// MCP server running in HTTP mode with the default security policy.
//   MUKAI_API_URL, MUKAI_API_TOKEN, MCP_URL (e.g. http://127.0.0.1:3333/mcp), MCP_AUTH_TOKEN
//   TEST_FOLDER: an empty directory the test workspace may use
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const { MUKAI_API_URL, MUKAI_API_TOKEN, MCP_URL, MCP_AUTH_TOKEN, TEST_FOLDER } = process.env;
for (const [k, v] of Object.entries({ MUKAI_API_URL, MUKAI_API_TOKEN, MCP_URL, MCP_AUTH_TOKEN, TEST_FOLDER }))
  if (!v) throw new Error(`${k} is required`);

// Direct Mukai REST: plays the role of "the human in the Mukai app / Telegram".
const mukai = async (method, path, body) => {
  const res = await fetch(MUKAI_API_URL + path, {
    method,
    headers: { Authorization: `Bearer ${MUKAI_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
};

/** MCP client; `human` answers elicitation prompts (null = client without elicitation support). */
async function connect(human) {
  const client = new Client({ name: 'e2e', version: '1' }, { capabilities: human ? { elicitation: {} } : {} });
  const prompts = [];
  if (human)
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params);
      return human(request.params, prompts.length);
    });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${MCP_AUTH_TOKEN}` } } }),
  );
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    const raw = result.content?.[0]?.text ?? '';
    const body = raw.replace(/^\[Mukai data[^\]]*\]\n/, '');
    let json;
    try {
      json = JSON.parse(body);
    } catch {}
    if (process.env.DEBUG) console.log('\n', name, raw.slice(0, 600));
    return { isError: !!result.isError, raw, json, text: body };
  };
  return { client, call, prompts };
}

let passed = 0;
const test = async (name, fn) => {
  process.stdout.write(`- ${name} … `);
  await fn();
  passed++;
  console.log('ok');
};

// ---- Fixture: workspace + mock provider + bot, approval mode on ----
const must = (value, what) => {
  if (!value?.id) throw new Error(`Fixture: could not create ${what}: ${JSON.stringify(value)}`);
  return value;
};
async function removeWorkspace(ws) {
  const bots = (await mukai('GET', `/bots?workspaceId=${ws.id}`)) || [];
  // Children before parents.
  for (const b of [...bots].sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))) await mukai('DELETE', `/bots/${b.id}`);
  await mukai('DELETE', `/workspaces/${ws.id}`, { name: ws.name });
}
for (const ws of (await mukai('GET', '/workspaces')) || []) if (/^E2E \d+$/.test(ws.name)) await removeWorkspace(ws);
const workspace = must(await mukai('POST', '/workspaces', { name: `E2E ${Date.now() % 100000}`, folder: TEST_FOLDER }), 'workspace');
let provider = (await mukai('GET', '/providers')).find((p) => p.name === 'E2E Mock');
provider ??= await mukai('POST', '/providers', {
  name: 'E2E Mock', kind: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'mock-1', supportsImages: false, isDefault: true,
});
const bot = must(await mukai('POST', '/bots', {
  workspaceId: workspace.id, name: 'Mukai', role: 'Main Bot/Orchestrator', instructions: 'Test bot.',
  providerId: provider.id, model: 'mock-1', supportsImages: null, avatar: 'mukai-logo',
}), 'bot');
await mukai('PUT', `/approvals?workspaceId=${workspace.id}`, { mode: 'ask-for-approval' });
const file = (name) => join(TEST_FOLDER, name);

console.log('Approvals — client WITH confirmation prompts (elicitation)');

await test('bot asks for approval → human approves in the prompt → reply completes, file written', async () => {
  const { client, call, prompts } = await connect(() => ({ action: 'accept', content: { decision: 'approve' } }));
  const r = await call('mukai_chat_with_bot', { botId: bot.id, text: 'WRITEFILE approved.txt' });
  assert.equal(r.json.status, 'done', r.text);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].message, /Tool: file_operations/);
  assert.match(prompts[0].message, /approved\.txt/); // shown from Mukai's own record
  assert.equal(r.json.humanDecisions[0].decision, 'approve');
  assert.equal(readFileSync(file('approved.txt'), 'utf8'), 'written via MCP approval test');
  await client.close();
});

await test('human rejects with a reason → tool does not run, bot is told why', async () => {
  const { client, call } = await connect(() => ({ action: 'accept', content: { decision: 'reject', reason: 'not now' } }));
  const r = await call('mukai_chat_with_bot', { botId: bot.id, text: 'WRITEFILE rejected.txt' });
  assert.equal(r.json.status, 'done', r.text);
  assert.equal(existsSync(file('rejected.txt')), false);
  assert.match(r.json.text, /not now|reject|denied/i);
  await client.close();
});

await test('human dismisses the prompt → still pending; model "approve" is only a suggestion the human must confirm', async () => {
  let answer = { action: 'decline' };
  const { client, call, prompts } = await connect(() => answer);
  const first = await call('mukai_chat_with_bot', { botId: bot.id, text: 'WRITEFILE later.txt' });
  assert.equal(first.json.status, 'awaiting_approval', first.text);
  assert.equal(first.json.pendingApprovals.length, 1);
  assert.match(first.json.hint, /human must decide/);
  const approval = first.json.pendingApprovals[0];

  // The model tries to approve; the human declines again → nothing is approved.
  const tried = await call('mukai_decide_approval', { workspaceId: approval.workspaceId, approvalId: approval.id, approved: true });
  assert.equal(tried.json.decided, false);
  assert.match(prompts.at(-1).message, /The AI assistant suggests: approve/);
  assert.equal((await mukai('GET', `/approvals?workspaceId=${workspace.id}`)).pending.length, 1);

  // Now the human accepts → applied, and the original run is collected by reattaching.
  answer = { action: 'accept', content: { decision: 'approve' } };
  const decided = await call('mukai_decide_approval', { workspaceId: approval.workspaceId, approvalId: approval.id, approved: true });
  assert.equal(decided.json.decided, true);
  const rest = await call('mukai_chat_with_bot', { botId: bot.id, text: 'WRITEFILE later.txt', requestId: first.json.requestId });
  assert.equal(rest.json.status, 'done', rest.text);
  assert.ok(existsSync(file('later.txt')));
  await client.close();
});

await test('sensitive action (new provider) needs human confirmation; declined → not created', async () => {
  let ok = false;
  const { client, call, prompts } = await connect(() => ({ action: 'accept', content: { confirm: ok } }));
  const args = { name: 'Evil', kind: 'compatible', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'x', supportsImages: false, isDefault: false, apiKey: 'sk-should-not-appear' };
  const denied = await call('mukai_create_provider', args);
  assert.equal(denied.isError, true);
  assert.match(denied.text, /declined/);
  assert.doesNotMatch(prompts[0].message, /sk-should-not-appear/); // secrets redacted in prompts
  assert.equal((await mukai('GET', '/providers')).some((p) => p.name === 'Evil'), false);
  ok = true;
  const created = await call('mukai_create_provider', args);
  assert.equal(created.isError, false, created.text);
  await mukai('DELETE', `/providers/${created.json.id}`);
  await client.close();
});

await test('switching Mukai to full-access needs confirmation; switching back to ask does not', async () => {
  const { client, call, prompts } = await connect(() => ({ action: 'accept', content: { confirm: false } }));
  const off = await call('mukai_set_approval_mode', { workspaceId: workspace.id, mode: 'full-access' });
  assert.equal(off.isError, true);
  assert.equal((await mukai('GET', `/approvals?workspaceId=${workspace.id}`)).mode, 'ask-for-approval');
  const on = await call('mukai_set_approval_mode', { workspaceId: workspace.id, mode: 'ask-for-approval' });
  assert.equal(on.isError, false);
  assert.equal(prompts.length, 1);
  await client.close();
});

console.log('Approvals — client WITHOUT confirmation prompts');

await test('pending approval is reported; the model cannot approve it; human approves in Mukai/Telegram while the tool waits', async () => {
  const { client, call } = await connect(null);
  const first = await call('mukai_chat_with_bot', { botId: bot.id, text: 'WRITEFILE elsewhere.txt' });
  assert.equal(first.json.status, 'awaiting_approval', first.text);
  const approval = first.json.pendingApprovals[0];
  assert.equal(approval.toolName, 'file_operations');

  const tried = await call('mukai_decide_approval', { workspaceId: approval.workspaceId, approvalId: approval.id, approved: true });
  assert.equal(tried.isError, true);
  assert.match(tried.text, /needs a human/);
  assert.equal(existsSync(file('elsewhere.txt')), false);

  // Re-attach in "wait" mode; meanwhile the human approves from the app/Telegram (same Mukai API).
  const waiting = call('mukai_chat_with_bot', {
    botId: bot.id, text: 'WRITEFILE elsewhere.txt', requestId: first.json.requestId, approvalHandling: 'wait', waitSeconds: 60,
  });
  await new Promise((r) => setTimeout(r, 1500));
  await mukai('POST', `/approvals/${approval.id}?workspaceId=${workspace.id}`, { approved: true });
  const done = await waiting;
  assert.equal(done.json.status, 'done', done.text);
  assert.ok(existsSync(file('elsewhere.txt')));
  await client.close();
});

await test('sensitive actions are refused outright', async () => {
  const { client, call } = await connect(null);
  const r = await call('mukai_delete_bot', { botId: bot.id });
  assert.equal(r.isError, true);
  assert.match(r.text, /needs a human/);
  assert.ok((await mukai('GET', `/bots?workspaceId=${workspace.id}`)).some((b) => b.id === bot.id));
  await client.close();
});

console.log('Requests started in the Mukai app (not via MCP), seen and answered through MCP');

/** Starts a chat exactly like the Mukai UI does (direct API, streamed) and resolves with the final message. */
function uiChat(text) {
  return (async () => {
    const res = await fetch(`${MUKAI_API_URL}/bots/${bot.id}/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MUKAI_API_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), text, attachmentIds: [] }),
    });
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      for (const line of buffer.split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'done' || event.type === 'error') return event.message;
        } catch {}
      }
    }
  })();
}
async function waitForPending(call, kind) {
  for (let i = 0; i < 50; i++) {
    const r = await call('mukai_list_pending_approvals');
    const item = r.json.pending.find((p) => p.kind === kind);
    if (item) return { item, list: r.json };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no pending ${kind}`);
}

await test('bot question asked in the app → listed via MCP with its options → human picks an answer → app gets it', async () => {
  const { client, call, prompts } = await connect(() => ({ action: 'accept', content: { choice: 'Green' } }));
  const reply = uiChat('ASKQ please');
  const { item, list } = await waitForPending(call, 'question');
  assert.equal(item.question, 'Which colour should the report use?');
  assert.deepEqual(item.options, ['Blue', 'Green']);
  assert.equal(item.workspaceName, workspace.name);
  assert.ok(list.count >= 1);
  const decided = await call('mukai_decide_approval', { approvalId: item.id, answer: 'Blue' });
  assert.equal(decided.json.decided, true, decided.text);
  assert.equal(decided.json.decision, 'answered: Green'); // the human's pick wins over the AI's suggestion
  assert.match(prompts[0].message, /Which colour/);
  assert.match(prompts[0].message, /The AI assistant suggests: Blue/);
  const final = await reply;
  assert.equal(final.status, 'complete');
  assert.match(final.content, /Green/);
  await client.close();
});

await test('yes/no go-ahead asked in the app → approved via MCP → app continues', async () => {
  const { client, call } = await connect(() => ({ action: 'accept', content: { decision: 'approve' } }));
  const reply = uiChat('ASKOK please');
  const { item } = await waitForPending(call, 'yes_no');
  assert.equal(item.question, 'May I publish the draft?');
  const decided = await call('mukai_decide_approval', { approvalId: item.id, approved: true });
  assert.equal(decided.json.decision, 'approve', decided.text);
  const final = await reply;
  assert.equal(final.status, 'complete');
  assert.match(final.content, /true/);
  await client.close();
});

await test('tool approval raised in the app → approved via MCP → tool runs', async () => {
  const { client, call } = await connect(() => ({ action: 'accept', content: { decision: 'approve' } }));
  const reply = uiChat('WRITEFILE from-app.txt');
  const { item } = await waitForPending(call, 'tool');
  assert.equal(item.tool, 'file_operations');
  await call('mukai_decide_approval', { approvalId: item.id, approved: true });
  assert.equal((await reply).status, 'complete');
  assert.ok(existsSync(file('from-app.txt')));
  await client.close();
});

if (process.env.MCP_URL_MODEL_POLICY) {
  await test('with MCP_APPROVAL_POLICY=model the assistant can approve directly (no prompt support needed)', async () => {
    const saved = process.env.MCP_URL;
    const { Client: C } = await import('@modelcontextprotocol/sdk/client/index.js');
    const c = new C({ name: 'e2e-model', version: '1' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(process.env.MCP_URL_MODEL_POLICY), {
        requestInit: { headers: { Authorization: `Bearer ${MCP_AUTH_TOKEN}` } },
      }),
    );
    const reply = uiChat('WRITEFILE model-policy.txt');
    let item;
    for (let i = 0; i < 50 && !item; i++) {
      const r = await c.callTool({ name: 'mukai_list_pending_approvals', arguments: {} });
      item = JSON.parse(r.content[0].text.replace(/^\[Mukai data[^\]]*\]\n/, '')).pending.find((p) => p.kind === 'tool');
      if (!item) await new Promise((r) => setTimeout(r, 200));
    }
    const r = await c.callTool({ name: 'mukai_decide_approval', arguments: { approvalId: item.id, workspaceId: item.workspaceId, approved: true } });
    assert.equal(!!r.isError, false, r.content[0].text);
    assert.equal((await reply).status, 'complete');
    assert.ok(existsSync(file('model-policy.txt')));
    await c.close();
    process.env.MCP_URL = saved;
  });
}

console.log('Hardening');

await test('raw API tool is not exposed by default; results are labelled untrusted', async () => {
  const { client, call } = await connect(null);
  const { tools } = await client.listTools();
  assert.equal(tools.some((t) => t.name === 'mukai_api_request'), false);
  const r = await call('mukai_list_workspaces');
  assert.match(r.raw, /^\[Mukai data/);
  await client.close();
});

await test('path traversal in IDs is rejected', async () => {
  const { client, call } = await connect(null);
  for (const botId of ['..', '../settings/api', '%2e%2e']) {
    const r = await call('mukai_get_bot_messages', { botId });
    assert.equal(r.isError, true, `botId=${botId} -> ${r.text}`);
    assert.doesNotMatch(r.text, /token/i);
  }
  await client.close();
});

await test('wrong MCP token → 401, then lockout → 429', async () => {
  let last;
  for (let i = 0; i < 12; i++)
    last = await fetch(MCP_URL, { method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(last.status, 429);
});

await removeWorkspace(workspace);
console.log(`\n${passed} passed`);
