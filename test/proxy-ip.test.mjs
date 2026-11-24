// MCP_TRUST_PROXY=cloudflare: lockout follows each visitor's real address (CF-Connecting-IP),
// so one attacker cannot lock everyone out. Needs `npm run build`; no Mukai backend required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('cloudflare mode: attacker is locked out, other visitors are not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mukai-proxy-'));
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      MUKAI_API_URL: 'http://127.0.0.1:9',
      MUKAI_API_TOKEN: 'x',
      MCP_AUTH_TOKEN: 'a'.repeat(40),
      MCP_TRUST_PROXY: 'cloudflare',
      PORT: '3520',
      MCP_STATE_FILE: join(dir, 's.json'),
    },
  });
  try {
    await new Promise((resolve) => child.stderr.on('data', (d) => /MCP server on/.test(String(d)) && resolve()));
    const hit = (ip) =>
      fetch('http://127.0.0.1:3520/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong', 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
        body: '{}',
      }).then((r) => r.status);
    let last;
    for (let i = 0; i < 12; i++) last = await hit('203.0.113.7');
    assert.equal(last, 429); // the attacker
    assert.equal(await hit('198.51.100.20'), 401); // someone else: not locked out
  } finally {
    child.kill();
  }
});
