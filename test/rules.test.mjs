// Unit tests for the permission store: precedence, operator file, locks. Run after `npm run build`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionStore, classifyRequest } from '../dist/rules.js';

const dir = mkdtempSync(join(tmpdir(), 'mukai-rules-'));
const operatorFile = join(dir, 'rules.json');
writeFileSync(
  operatorFile,
  JSON.stringify({
    workspaces: {
      '*': { requests: { terminal: 'ask' }, locked: ['requests.terminal'] },
      sandbox: { mode: 'i-own-it', actions: { delete: 'allow' } },
    },
  }),
);
const store = () => new PermissionStore(join(dir, 'state.json'), 'ask-for-approval', operatorFile, 'confirm');

test('modes set the baseline', () => {
  const s = store();
  assert.equal(s.request('main', 'files-write').decision, 'ask');
  assert.equal(s.request('sandbox', 'questions').decision, 'allow'); // operator: sandbox is i-own-it
  s.setMode('main', 'full-access');
  assert.equal(s.request('main', 'files-write').decision, 'allow');
  assert.equal(s.request('main', 'questions').decision, 'ask');
});

test('operator lock beats every mode and user rule', () => {
  const s = store();
  assert.equal(s.request('sandbox', 'terminal').decision, 'ask');
  assert.equal(s.request('sandbox', 'terminal').locked, true);
  assert.throws(() => s.setRule('sandbox', 'requests', 'terminal', 'allow'), /locked/);
});

test('user rules beat operator defaults; workspace beats all-workspaces', () => {
  const s = store();
  assert.equal(s.action('sandbox', 'delete').decision, 'allow');
  s.setRule('sandbox', 'actions', 'delete', 'ask');
  assert.equal(s.action('sandbox', 'delete').decision, 'ask');
  s.setRule('*', 'actions', 'providers', 'allow');
  s.setRule('main', 'actions', 'providers', 'ask');
  assert.equal(s.action('main', 'providers').decision, 'ask');
  assert.equal(s.action('other', 'providers').decision, 'allow');
});

test('rules persist across restarts', () => {
  assert.equal(store().action('sandbox', 'delete').decision, 'ask');
});

test('sensitive actions ask in every mode; browser control follows the mode', () => {
  const s = new PermissionStore(join(dir, 'fresh.json'), 'i-own-it', undefined, 'confirm');
  assert.equal(s.action('x', 'custom-code').decision, 'ask');
  assert.equal(s.action('x', 'browser-control').decision, 'allow');
});

test('bad operator files fail loudly', () => {
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ workspaces: { '*': { requests: { teleport: 'allow' } } } }));
  assert.throws(() => new PermissionStore(join(dir, 'b.json'), 'ask-for-approval', bad, 'confirm'), /unknown requests category/);
});

test('request classification', () => {
  assert.equal(classifyRequest({ toolName: 'file_operations', input: { action: 'read_file' } }), 'files-read');
  assert.equal(classifyRequest({ toolName: 'file_operations', input: { action: 'write_file', overwrite: true } }), 'files-overwrite');
  assert.equal(classifyRequest({ toolName: 'terminal', input: {} }), 'terminal');
  assert.equal(classifyRequest({ toolName: 'my_stock_tool', input: {} }), 'custom-tools');
  assert.equal(classifyRequest({ ask: { action: 'clarification' } }), 'questions');
});
