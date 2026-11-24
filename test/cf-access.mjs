// Cloudflare Zero Trust (Access service token) test.
//
// Puts a fake Cloudflare Access gate in front of a REAL Mukai backend: requests without the
// right CF-Access-Client-Id / CF-Access-Client-Secret are redirected to a login page (like
// Access does); valid ones are forwarded with the token stripped. Then starts MCP servers with
// no token, a wrong token and the right token, and checks each one, including streamed chat.
//
// Needs: Mukai running at MUKAI_API_URL (e.g. http://127.0.0.1:47831), MUKAI_API_TOKEN,
// test/mock-llm.mjs on :11434, `npm run build` done, and TEST_FOLDER (an empty directory).
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { MUKAI_API_URL, MUKAI_API_TOKEN, TEST_FOLDER } = process.env;
for (const [k, v] of Object.entries({ MUKAI_API_URL, MUKAI_API_TOKEN, TEST_FOLDER })) if (!v) throw new Error(`${k} is required`);
const ID = 'test-client.access';
const SECRET = 'cf-secret-' + 'x'.repeat(40);
const MCP_TOKEN = 'm'.repeat(48);
const GATE_PORT = 47999;
const upstream = new URL(MUKAI_API_URL);

// ---- Fake Cloudflare Access gate ----
const seen = { allowed: 0, refused: 0, leakedToMukai: 0 };
const gate = http.createServer((req, res) => {
  if (req.headers['cf-access-client-id'] !== ID || req.headers['cf-access-client-secret'] !== SECRET) {
    seen.refused++;
    res.writeHead(302, { Location: 'https://example-team.cloudflareaccess.com/cdn-cgi/access/login/mukai?redirect_url=%2F' });
    return res.end();
  }
  seen.allowed++;
  const headers = { ...req.headers, host: upstream.host };
  delete headers['cf-access-client-id']; // Access strips the service token before forwarding
  delete headers['cf-access-client-secret'];
  const forward = http.request({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res); // streams chat events through unbuffered
  });
  req.pipe(forward);
});
await new Promise((r) => gate.listen(GATE_PORT, '127.0.0.1', r));

// ---- MCP servers under test ----
const children = [];
function startMcp(port, extraEnv) {
  const logs = [];
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      MUKAI_API_URL: `http://127.0.0.1:${GATE_PORT}`,
      MUKAI_API_TOKEN,
      MCP_AUTH_TOKEN: MCP_TOKEN,
      PORT: String(port),
      MCP_STATE_FILE: `${TEST_FOLDER}/state-${port}.json`,
      ...extraEnv,
    },
  });
  child.stderr.on('data', (d) => logs.push(String(d)));
  children.push(child);
  return {
    logs,
    exited: new Promise((r) => child.on('exit', (code) => r(code))),
    ready: new Promise((resolve) => {
      const check = (d) => /listening|MCP server on/.test(String(d)) && resolve();
      child.stderr.on('data', check);
    }),
  };
}
async function connect(port) {
  const client = new Client({ name: 'cf-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    }),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
    const raw = r.content?.[0]?.text ?? '';
    let json;
    try {
      json = JSON.parse(raw.replace(/^\[Mukai data[^\]]*\]\n/, ''));
    } catch {}
    return { isError: !!r.isError, text: raw, json };
  };
  return { client, call };
}

let passed = 0;
const test = async (name, fn) => {
  process.stdout.write(`- ${name} … `);
  await fn();
  passed++;
  console.log('ok');
};

try {
  console.log('Cloudflare Zero Trust (Access service token)');

  await test('refuses to start with only one of the two settings', async () => {
    const s = startMcp(3409, { MUKAI_CF_ACCESS_CLIENT_ID: ID });
    assert.equal(await s.exited, 1);
    assert.match(s.logs.join(''), /Set both MUKAI_CF_ACCESS_CLIENT_ID and MUKAI_CF_ACCESS_CLIENT_SECRET/);
  });

  await test('refuses to send the service token over plain HTTP to another machine', async () => {
    const s = startMcp(3408, { MUKAI_API_URL: 'http://mukai.example.com/api', MUKAI_CF_ACCESS_CLIENT_ID: ID, MUKAI_CF_ACCESS_CLIENT_SECRET: SECRET });
    assert.equal(await s.exited, 1);
    assert.match(s.logs.join(''), /Refusing to send the Cloudflare Access service token over plain HTTP/);
  });

  await test('without a service token: a clear "behind Cloudflare Access" error, not a login page', async () => {
    const s = startMcp(3401, {});
    await s.ready;
    const { client, call } = await connect(3401);
    const r = await call('mukai_list_workspaces');
    assert.equal(r.isError, true);
    assert.match(r.text, /redirected to example-team\.cloudflareaccess\.com/);
    assert.match(r.text, /set MUKAI_CF_ACCESS_CLIENT_ID and MUKAI_CF_ACCESS_CLIENT_SECRET/);
    await client.close();
  });

  await test('wrong secret: refused, with advice to check the token and Service Auth policy', async () => {
    const s = startMcp(3402, { MUKAI_CF_ACCESS_CLIENT_ID: ID, MUKAI_CF_ACCESS_CLIENT_SECRET: 'wrong-' + 'y'.repeat(30) });
    await s.ready;
    const { client, call } = await connect(3402);
    const r = await call('mukai_list_workspaces');
    assert.equal(r.isError, true);
    assert.match(r.text, /Service Auth/);
    await client.close();
  });

  await test('right token: tools work through Access, including a streamed bot chat; secret never appears in output or logs', async () => {
    const s = startMcp(3403, { MUKAI_CF_ACCESS_CLIENT_ID: ID, MUKAI_CF_ACCESS_CLIENT_SECRET: SECRET });
    await s.ready;
    const { client, call } = await connect(3403);
    const before = seen.allowed;
    const list = await call('mukai_list_workspaces');
    assert.equal(list.isError, false, list.text);
    assert.ok(seen.allowed > before);

    // A real chat through the gate (streamed NDJSON).
    const mukai = async (method, path, body) => {
      const res = await fetch(MUKAI_API_URL + path, {
        method,
        headers: { Authorization: `Bearer ${MUKAI_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: body && JSON.stringify(body),
      });
      const t = await res.text();
      return t ? JSON.parse(t) : undefined;
    };
    const ws = await mukai('POST', '/workspaces', { name: `CF ${Date.now() % 100000}`, folder: TEST_FOLDER });
    let provider = (await mukai('GET', '/providers')).find((p) => p.name === 'E2E Mock');
    provider ??= await mukai('POST', '/providers', { name: 'E2E Mock', kind: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'mock-1', supportsImages: false, isDefault: false });
    const bot = await mukai('POST', '/bots', { workspaceId: ws.id, name: 'Mukai', role: 'Main Bot/Orchestrator', instructions: 'x', providerId: provider.id, model: 'mock-1', supportsImages: null, avatar: 'mukai-logo' });
    const chat = await call('mukai_chat_with_bot', { botId: bot.id, text: 'hello through Cloudflare' });
    assert.equal(chat.json?.status, 'done', chat.text);
    assert.match(chat.json.text, /Hello from the mock model/);
    await mukai('DELETE', `/bots/${bot.id}`);
    await mukai('DELETE', `/workspaces/${ws.id}`, { name: ws.name });

    assert.doesNotMatch(list.text + chat.text, new RegExp(SECRET));
    assert.doesNotMatch(s.logs.join(''), new RegExp(SECRET));
    await client.close();
  });

  console.log(`\n${passed} passed (gate: ${seen.allowed} allowed, ${seen.refused} refused)`);
} finally {
  for (const child of children) child.kill();
  gate.close();
}
