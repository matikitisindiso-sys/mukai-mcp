// Real-browser check of the login page: clicking "Allow" must actually continue to the app's
// callback (browsers enforce CSP form-action on the redirect after a form submission).
// Needs `npm run build` and Playwright's Chromium. No Mukai backend required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {}

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

test('login page: Allow and Deny continue to the app in a real browser', { skip: !chromium && 'playwright not installed' }, async () => {
  const port = 3540;
  const base = `http://localhost:${port}`;
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      MUKAI_API_URL: 'http://127.0.0.1:9',
      MUKAI_API_TOKEN: 'x',
      PORT: String(port),
      MCP_PUBLIC_URL: base,
      MCP_OWNER_PASSWORD: 'browser test password',
      MCP_OAUTH_STATE_FILE: join(mkdtempSync(join(tmpdir(), 'mukai-oauth-browser-')), 'o.json'),
      MCP_STATE_FILE: join(mkdtempSync(join(tmpdir(), 'mukai-oauth-browser-')), 's.json'),
    },
  });
  // Point claude.ai at a dead local port: we only need to see the browser *try* to go there.
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP claude.ai 127.0.0.1:9'] });
  try {
    await new Promise((resolve) => child.stderr.on('data', (d) => /MCP server on/.test(String(d)) && resolve()));
    const reg = await (
      await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }),
      })
    ).json();
    const authorizeUrl =
      `${base}/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(CALLBACK)}` +
      '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=browser-state';

    for (const [button, expectParam] of [
      ['Allow', 'code'],
      ['Deny', 'error'],
    ]) {
      const page = await browser.newPage();
      let landed;
      // Record the navigation to the app (redirected requests cannot be intercepted, but are observable).
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.hostname === 'claude.ai') landed = url;
      });
      await page.goto(authorizeUrl);
      await page.fill('#password', 'browser test password');
      await page.click(`button:has-text("${button}")`);
      for (let i = 0; i < 50 && !landed; i++) await page.waitForTimeout(100);
      assert.ok(landed, `${button}: browser never reached the app`);
      assert.equal(landed.origin + landed.pathname, CALLBACK);
      assert.ok(landed.searchParams.get(expectParam), `${button}: missing ${expectParam}`);
      assert.equal(landed.searchParams.get('state'), 'browser-state');
      await page.close();
    }
  } finally {
    await browser.close();
    child.kill();
  }
});
