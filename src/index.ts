#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { MukaiClient } from './client.js';
import { registerTools } from './tools.js';

const VERSION = '0.1.0';

function env(name: string, fallback?: string) {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

const apiUrl = env('MUKAI_API_URL', 'http://127.0.0.1:47831')!;
const apiToken = env('MUKAI_API_TOKEN');
const chatWaitSeconds = Number(env('MUKAI_CHAT_WAIT_SECONDS', '55'));
const stdio = process.argv.includes('--stdio') || env('MCP_TRANSPORT') === 'stdio';

if (!apiToken) {
  console.error('MUKAI_API_TOKEN is required (Mukai Settings -> API, or the api.token file in the Mukai data directory).');
  process.exit(1);
}

const client = new MukaiClient({ baseUrl: apiUrl, token: apiToken });

function createServer() {
  const server = new McpServer(
    { name: 'mukai', version: VERSION },
    {
      instructions:
        'Tools for controlling a Mukai workspace backend: workspaces, bots, chats/spaces, approvals, pursuits, memory, providers, skills, custom capabilities, browser, notifications, Telegram and settings. ' +
        'Most tools take an optional workspaceId (defaults to "default"); start with mukai_list_workspaces and mukai_list_bots. ' +
        'Use mukai_chat_with_bot or mukai_send_conversation_message to talk to bots; if a run pauses for approval, resolve it with mukai_get_approvals / mukai_decide_approval and re-call with the same requestId. ' +
        'mukai_api_request reaches any route without a dedicated tool.',
    },
  );
  registerTools(server, client, { chatWaitSeconds });
  return server;
}

async function runStdio() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`Mukai MCP server (stdio) -> ${apiUrl}`);
}

async function runHttp() {
  const authToken = env('MCP_AUTH_TOKEN');
  const allowNoAuth = env('MCP_ALLOW_NO_AUTH') === 'true';
  if (!authToken && !allowNoAuth) {
    console.error('MCP_AUTH_TOKEN is required for HTTP mode (set MCP_ALLOW_NO_AUTH=true only for trusted local testing).');
    process.exit(1);
  }
  const host = env('HOST', '0.0.0.0')!;
  const port = Number(env('PORT', '3333'));
  const allowedHosts = env('MCP_ALLOWED_HOSTS')?.split(',').map((item) => item.trim()).filter(Boolean);
  const app = createMcpExpressApp({ host, allowedHosts });
  app.set('trust proxy', true);

  const expected = authToken ? Buffer.from(authToken) : undefined;
  const authenticate = (req: Request, res: Response, next: NextFunction) => {
    if (!expected) return next();
    const header = req.headers.authorization || '';
    // Bearer header preferred; ?token= supported for clients that can only set a URL.
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || ''));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    res.status(401).set('WWW-Authenticate', 'Bearer').json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
  };

  app.get('/health', async (_req, res) => {
    try {
      const backend = await client.json('GET', '/health');
      res.json({ status: 'ok', service: 'mukai-mcp', version: VERSION, backend });
    } catch (error) {
      res.status(502).json({ status: 'degraded', service: 'mukai-mcp', version: VERSION, error: String((error as Error).message) });
    }
  });

  // Stateless Streamable HTTP: a fresh server/transport per request, so the
  // service scales horizontally and survives restarts without session affinity.
  app.post('/mcp', authenticate, async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request failed:', error);
      if (!res.headersSent)
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  const methodNotAllowed = (_req: Request, res: Response) =>
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get('/mcp', authenticate, methodNotAllowed);
  app.delete('/mcp', authenticate, methodNotAllowed);

  app.listen(port, host, () => {
    console.error(`Mukai MCP server listening on http://${host}:${port}/mcp -> ${apiUrl}`);
  });
}

(stdio ? runStdio() : runHttp()).catch((error) => {
  console.error(error);
  process.exit(1);
});
