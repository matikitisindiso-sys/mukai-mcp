// OAuth sign-in test: walks the same flow the Claude app uses, plus the attacks it must stop.
// Needs: Mukai running at MUKAI_API_URL, MUKAI_API_TOKEN, `npm run build` done, TEST_FOLDER.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { MUKAI_API_URL, MUKAI_API_TOKEN, TEST_FOLDER } = process.env;
for (const [k, v] of Object.entries({ MUKAI_API_URL, MUKAI_API_TOKEN, TEST_FOLDER })) if (!v) throw new Error(`${k} is required`);
const PORT = 3510;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'correct horse battery staple';
const STATIC = 's'.repeat(48);
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let child;
async function start(password = PASSWORD) {
  child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      MUKAI_API_URL,
      MUKAI_API_TOKEN,
      PORT: String(PORT),
      MCP_PUBLIC_URL: BASE,
      MCP_OWNER_PASSWORD: password,
      MCP_AUTH_TOKEN: STATIC,
      MCP_OAUTH_STATE_FILE: `${TEST_FOLDER}/oauth.json`,
      MCP_STATE_FILE: `${TEST_FOLDER}/state.json`,
    },
  });
  const logs = [];
  child.stderr.on('data', (d) => logs.push(String(d)));
  await new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => /MCP server on/.test(String(d)) && resolve());
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${logs.join('')}`)));
  });
  return logs;
}
async function stop() {
  child.kill();
  await new Promise((r) => child.on('exit', r));
}

const form = (data) => new URLSearchParams(Object.entries(data).filter(([, v]) => v !== undefined));
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
async function register(redirect_uris = [CALLBACK]) {
  const res = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  return { status: res.status, body: await res.json() };
}
async function authorizePage(clientId, challenge, state = 'st-123') {
  const url = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state, resource: `${BASE}/mcp`, scope: 'mukai' }))
    url.searchParams.set(k, v);
  const res = await fetch(url, { redirect: 'manual' });
  const html = await res.text();
  return { res, html, pending: /name="pending" value="([^"]+)"/.exec(html)?.[1] };
}
async function login(pending, password, action = 'allow') {
  return fetch(`${BASE}/oauth/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ pending, password, action }) });
}
async function token(data) {
  const res = await fetch(`${BASE}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(data) });
  return { status: res.status, body: await res.json() };
}
async function signIn(clientId) {
  const { verifier, challenge } = pkce();
  const page = await authorizePage(clientId, challenge);
  const redirect = new URL((await login(page.pending, PASSWORD)).headers.get('location'));
  return (await token({ grant_type: 'authorization_code', client_id: clientId, code: redirect.searchParams.get('code'), code_verifier: verifier, redirect_uri: CALLBACK, resource: `${BASE}/mcp` })).body;
}
async function mcpWorks(accessToken) {
  const client = new Client({ name: 'oauth-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
    const r = await client.callTool({ name: 'mukai_list_workspaces', arguments: {} });
    await client.close();
    return !r.isError;
  } catch {
    return false;
  }
}

let passed = 0;
const test = async (name, fn) => {
  process.stdout.write(`- ${name} … `);
  await fn();
  passed++;
  console.log('ok');
};

try {
  console.log('OAuth sign-in (the Claude app flow)');
  await start();
  let clientId;
  let tokens;

  await test('unauthenticated /mcp → 401 pointing to the sign-in metadata (how the app discovers OAuth)', async () => {
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:3510\/\.well-known\/oauth-protected-resource\/mcp"/);
    const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${BASE}/mcp`);
    const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    assert.ok(as.authorization_endpoint && as.token_endpoint && as.registration_endpoint);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  });

  await test('registration only accepts allowed callback addresses', async () => {
    const evil = await register(['https://evil.example/callback']);
    assert.equal(evil.status, 400);
    assert.equal(evil.body.error, 'invalid_client_metadata');
    const ok = await register();
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    clientId = ok.body.client_id;
    assert.equal((await register(['http://localhost:7777/callback'])).status, 201); // local apps (e.g. Claude Code)
  });

  await test('login page: owner password, cannot be framed, no scripts', async () => {
    const { res, html, pending } = await authorizePage(clientId, pkce().challenge);
    assert.equal(res.status, 200);
    assert.ok(pending);
    assert.match(html, /Connect to Mukai/);
    assert.match(html, /claude\.ai/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(html, /<script/i);
  });

  await test('wrong password is refused; Deny returns access_denied to the app', async () => {
    const { pending } = await authorizePage(clientId, pkce().challenge);
    const wrong = await login(pending, 'not the password');
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /Wrong password/);
    const denied = await login(pending, '', 'deny');
    assert.equal(denied.status, 302);
    const back = new URL(denied.headers.get('location'));
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('state'), 'st-123');
  });

  await test('right password → code → tokens (PKCE enforced, code single-use) → MCP works', async () => {
    const { verifier, challenge } = pkce();
    const { pending } = await authorizePage(clientId, challenge);
    const ok = await login(pending, PASSWORD);
    assert.equal(ok.status, 302);
    const back = new URL(ok.headers.get('location'));
    assert.equal(back.origin + back.pathname, CALLBACK);
    assert.equal(back.searchParams.get('state'), 'st-123');
    const code = back.searchParams.get('code');
    const badVerifier = await token({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pkce().verifier, redirect_uri: CALLBACK });
    assert.equal(badVerifier.body.error, 'invalid_grant');
    const good = await token({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: CALLBACK, resource: `${BASE}/mcp` });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    tokens = good.body;
    assert.ok(tokens.access_token && tokens.refresh_token);
    assert.equal(tokens.expires_in, 3600);
    const again = await token({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: CALLBACK });
    assert.equal(again.body.error, 'invalid_grant');
    assert.equal(await mcpWorks(tokens.access_token), true);
  });

  await test('refresh rotates tokens; reusing an old refresh token ends the whole sign-in', async () => {
    const refreshed = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.notEqual(refreshed.body.refresh_token, tokens.refresh_token);
    assert.equal(await mcpWorks(refreshed.body.access_token), true);
    const stolen = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token });
    assert.equal(stolen.body.error, 'invalid_grant');
    assert.equal(await mcpWorks(refreshed.body.access_token), false); // family revoked
  });

  await test('sign-ins survive a restart; changing the owner password signs every app out', async () => {
    const fresh = await signIn(clientId);
    await stop();
    await start();
    assert.equal(await mcpWorks(fresh.access_token), true);
    await stop();
    await start('a completely new owner password');
    assert.equal(await mcpWorks(fresh.access_token), false);
  });

  await test('the static MCP_AUTH_TOKEN still works alongside OAuth (e.g. for Claude Code)', async () => {
    assert.equal(await mcpWorks(STATIC), true);
  });

  await test('5 wrong passwords lock the login page for that address', async () => {
    const { pending } = await authorizePage(clientId, pkce().challenge);
    for (let i = 0; i < 5; i++) await login(pending, 'nope');
    const locked = await login(pending, 'a completely new owner password');
    assert.equal(locked.status, 429);
  });

  console.log(`\n${passed} passed`);
} finally {
  if (child && child.exitCode === null) await stop();
}
