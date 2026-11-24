// Container health checks call http://127.0.0.1:3333/health. With MCP_ALLOWED_HOSTS set,
// /health must still answer, while everything else keeps refusing other Host headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('health check passes from inside the container even with MCP_ALLOWED_HOSTS', async () => {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      MUKAI_API_URL: 'http://127.0.0.1:9',
      MUKAI_API_TOKEN: 'x',
      MCP_AUTH_TOKEN: 'a'.repeat(40),
      MCP_ALLOWED_HOSTS: 'mcp.example.com',
      PORT: '3521',
      MCP_STATE_FILE: join(mkdtempSync(join(tmpdir(), 'mukai-health-')), 's.json'),
    },
  });
  try {
    await new Promise((resolve) => child.stderr.on('data', (d) => /MCP server on/.test(String(d)) && resolve()));
    assert.equal((await fetch('http://127.0.0.1:3521/health')).status, 200);
    assert.equal((await fetch('http://127.0.0.1:3521/mcp', { method: 'POST' })).status, 403);
  } finally {
    child.kill();
  }
});
