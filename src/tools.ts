import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MukaiApiError, type MukaiClient, type Query, type RawResponse } from './client.js';
import { botFields, endpoints, type Endpoint } from './endpoints.js';

const MAX_INLINE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;

export interface ToolOptions {
  chatWaitSeconds: number;
}

function text(value: unknown): CallToolResult {
  let body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (body === undefined) body = 'OK';
  if (body.length > MAX_TEXT_CHARS)
    body = body.slice(0, MAX_TEXT_CHARS) + `\n\n…[truncated ${body.length - MAX_TEXT_CHARS} characters]`;
  return { content: [{ type: 'text', text: body }] };
}

function failure(error: unknown): CallToolResult {
  const message =
    error instanceof MukaiApiError
      ? error.message
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function binaryResult(response: RawResponse, label: string): CallToolResult {
  const type = response.contentType.split(';')[0].trim() || 'application/octet-stream';
  const name = response.filename || label;
  if (response.bytes.length > MAX_INLINE_BYTES)
    return text(`File "${name}" (${type}, ${response.bytes.length} bytes) is too large to return inline.`);
  if (type.startsWith('image/'))
    return {
      content: [
        { type: 'image', data: response.bytes.toString('base64'), mimeType: type },
        { type: 'text', text: `${name} (${type}, ${response.bytes.length} bytes)` },
      ],
    };
  if (type.startsWith('text/') || /json|xml|javascript|yaml|csv|markdown/.test(type))
    return text(`File: ${name} (${type})\n\n${response.bytes.toString('utf8')}`);
  return {
    content: [
      {
        type: 'resource',
        resource: { uri: `mukai://file/${encodeURIComponent(name)}`, mimeType: type, blob: response.bytes.toString('base64') },
      },
      { type: 'text', text: `${name} (${type}, ${response.bytes.length} bytes, base64 resource)` },
    ],
  };
}

function buildRequest(endpoint: Endpoint, args: Record<string, unknown>) {
  const used = new Set<string>();
  const path = endpoint.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    used.add(key);
    const value = args[key];
    if (value === undefined || value === null || value === '') throw new Error(`Missing required path parameter "${key}".`);
    return encodeURIComponent(String(value));
  });
  const query: Query = {};
  for (const key of endpoint.query || []) {
    used.add(key);
    if (args[key] !== undefined) query[key] = args[key] as Query[string];
  }
  let body: unknown;
  if (endpoint.method !== 'GET') {
    if (endpoint.bodyKey) body = args[endpoint.bodyKey];
    else {
      const rest = Object.fromEntries(Object.entries(args).filter(([key, value]) => !used.has(key) && value !== undefined));
      body = rest;
    }
  }
  return { path, query, body };
}

function registerEndpoint(server: McpServer, client: MukaiClient, endpoint: Endpoint) {
  server.registerTool(
    endpoint.name,
    {
      description: `${endpoint.description}\n\n[${endpoint.method} ${endpoint.path}]`,
      inputSchema: endpoint.input || {},
      annotations: {
        readOnlyHint: endpoint.method === 'GET',
        destructiveHint: endpoint.destructive ?? false,
        openWorldHint: false,
      },
    },
    async (args: Record<string, unknown>) => {
      try {
        const request = buildRequest(endpoint, args || {});
        if (endpoint.binary) {
          const response = await client.raw(endpoint.method, request.path, { query: request.query, body: request.body });
          return binaryResult(response, endpoint.name);
        }
        return text(await client.json(endpoint.method, request.path, { query: request.query, body: request.body }));
      } catch (error) {
        return failure(error);
      }
    },
  );
}

const chatWait = (defaultSeconds: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(3600)
    .default(defaultSeconds)
    .describe('Seconds to wait for the reply. The run continues on the server if this expires; poll messages or re-call with the same requestId to reattach.');
const returnOnApproval = z
  .boolean()
  .default(true)
  .describe('Return as soon as the bot needs a tool approval or asks a question (resolve it with mukai_decide_approval).');

type ChatRun = Awaited<ReturnType<MukaiClient['chat']>>;

/** Finds the real pending approvals (with IDs, tool name and input) for this run's messages. */
async function pendingApprovals(client: MukaiClient, result: ChatRun) {
  if (!result.approvalMessageIds.length && result.status !== 'awaiting_approval') return [];
  const workspaces = (await client.json<{ id: string }[]>('GET', '/workspaces').catch(() => [])) || [];
  const found: Record<string, unknown>[] = [];
  for (const workspace of workspaces) {
    const state = await client
      .json<{ pending?: Record<string, unknown>[] }>('GET', '/approvals', { query: { workspaceId: workspace.id } })
      .catch(() => undefined);
    for (const item of state?.pending || [])
      if (
        result.approvalMessageIds.includes(String(item.messageId)) ||
        (result.conversationId && item.conversationId === result.conversationId)
      )
        found.push({ ...item, workspaceId: workspace.id });
  }
  return found;
}

async function chatSummary(client: MukaiClient, result: ChatRun) {
  const hints: Record<string, string> = {
    awaiting_approval:
      'The bot is waiting for a human decision. Resolve each entry in pendingApprovals with mukai_decide_approval (approvalId = its id, workspaceId = its workspaceId), then call this tool again with the same requestId (and same text) to reattach and wait for the rest.',
    timeout:
      'Wait budget expired; the bot is still working on the server. Re-call with the same requestId to keep waiting, or read the messages later.',
    stream_closed: 'The stream closed before a final event. Check the conversation messages for the final state.',
  };
  const { approvalMessageIds: _ids, ...rest } = result;
  const approvals = await pendingApprovals(client, result);
  return { ...rest, pendingApprovals: approvals, hint: hints[result.status] };
}

export function registerTools(server: McpServer, client: MukaiClient, options: ToolOptions) {
  for (const endpoint of endpoints) registerEndpoint(server, client, endpoint);

  // ---- Chat (streamed NDJSON, collected into one result) --------------------
  server.registerTool(
    'mukai_chat_with_bot',
    {
      description:
        "Send a message to a bot's main chat and wait for its reply (streams the run and returns final text, tool activity, and any pending approvals). [POST /bots/{botId}/chat]",
      inputSchema: {
        botId: z.string().min(1),
        text: z.string().max(16000),
        attachmentIds: z.array(z.string().uuid()).max(4).default([]).describe('IDs from mukai_upload_attachment'),
        requestId: z.string().uuid().optional().describe('Reuse to reattach to an existing run; generated if omitted.'),
        waitSeconds: chatWait(options.chatWaitSeconds),
        returnOnApproval,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ botId, text: message, attachmentIds, requestId, waitSeconds, returnOnApproval }) => {
      try {
        const result = await client.chat(
          `/bots/${encodeURIComponent(botId)}/chat`,
          { requestId: requestId || randomUUID(), text: message, attachmentIds },
          { waitSeconds, returnOnApproval },
        );
        return text(await chatSummary(client, result));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'mukai_send_conversation_message',
    {
      description:
        'Send a message in a conversation (private chat, space, bot thread or pursuit run) and wait for the reply. For spaces, botId picks the responding bot (null lets Mukai choose). [POST /conversations/{conversationId}/chat]',
      inputSchema: {
        conversationId: z.string().min(1),
        text: z.string().max(16000),
        botId: z.string().nullable().default(null).describe('Spaces only: bot to respond'),
        attachmentIds: z.array(z.string().uuid()).max(4).default([]),
        requestId: z.string().uuid().optional(),
        waitSeconds: chatWait(options.chatWaitSeconds),
        returnOnApproval,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ conversationId, text: message, botId, attachmentIds, requestId, waitSeconds, returnOnApproval }) => {
      try {
        const result = await client.chat(
          `/conversations/${encodeURIComponent(conversationId)}/chat`,
          { requestId: requestId || randomUUID(), text: message, botId, attachmentIds },
          { waitSeconds, returnOnApproval },
        );
        return text(await chatSummary(client, result));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'mukai_retry_conversation_message',
    {
      description: 'Retry the latest failed/stopped/interrupted response in a conversation and wait for it. [POST /conversations/{conversationId}/retry]',
      inputSchema: {
        conversationId: z.string().min(1),
        messageId: z.string().uuid().describe('Assistant message ID to retry'),
        waitSeconds: chatWait(options.chatWaitSeconds),
        returnOnApproval,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ conversationId, messageId, waitSeconds, returnOnApproval }) => {
      try {
        const result = await client.chat(
          `/conversations/${encodeURIComponent(conversationId)}/retry`,
          { messageId },
          // The retry body schema is strict: it accepts messageId only.
          { waitSeconds, returnOnApproval, sendRequestId: false },
        );
        return text(await chatSummary(client, result));
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ---- Uploads ---------------------------------------------------------------
  server.registerTool(
    'mukai_upload_attachment',
    {
      description:
        'Upload a file for a bot (or a specific private conversation) to attach to the next message. Provide text content or base64 content. Returns the attachment (use its id in attachmentIds). [POST /bots/{botId}/attachments | /conversations/{conversationId}/attachments]',
      inputSchema: {
        botId: z.string().optional().describe('Upload to this bot (main chat). Provide botId or conversationId.'),
        conversationId: z.string().optional().describe('Upload into this private/bot conversation'),
        filename: z.string().min(1).max(255),
        content: z.string().describe('File content'),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ botId, conversationId, filename, content, encoding }) => {
      try {
        if (!botId && !conversationId) throw new Error('Provide botId or conversationId.');
        const path = conversationId
          ? `/conversations/${encodeURIComponent(conversationId)}/attachments`
          : `/bots/${encodeURIComponent(botId!)}/attachments`;
        const response = await client.raw('POST', path, {
          rawBody: Buffer.from(content, encoding),
          headers: { 'X-Filename': encodeURIComponent(filename) },
        });
        return text(response.bytes.toString('utf8'));
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ---- Partial bot update (read-merge-PUT) -----------------------------------
  const partialBot = Object.fromEntries(Object.entries(botFields).map(([key, schema]) => [key, schema.optional()]));
  server.registerTool(
    'mukai_update_bot',
    {
      description: 'Update only the given fields of a bot (reads the current bot, merges, then PUTs). [PUT /bots/{botId}]',
      inputSchema: { botId: z.string().min(1), workspaceId: z.string().optional().describe('Speeds up lookup; searched across workspaces if omitted.'), ...partialBot },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args: Record<string, unknown>) => {
      try {
        const { botId, workspaceId, ...changes } = args as { botId: string; workspaceId?: string } & Record<string, unknown>;
        const workspaceIds = workspaceId
          ? [workspaceId]
          : ((await client.json<{ id: string }[]>('GET', '/workspaces')) || []).map((item) => item.id);
        let current: Record<string, unknown> | undefined;
        for (const wid of workspaceIds) {
          const list = await client.json<Record<string, unknown>[]>('GET', '/bots', { query: { workspaceId: wid } });
          current = (Array.isArray(list) ? list : []).find((bot) => String(bot.id) === String(botId));
          if (current) break;
        }
        if (!current) throw new Error(`Bot ${botId} not found.`);
        const body: Record<string, unknown> = {};
        for (const key of Object.keys(botFields)) {
          const value = key in changes && changes[key] !== undefined ? changes[key] : current[key];
          if (value !== undefined) body[key] = value;
        }
        body.providerId ??= null;
        body.model ??= null;
        body.supportsImages ??= null;
        return text(await client.json('PUT', `/bots/${encodeURIComponent(botId)}`, { body }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ---- Escape hatch ------------------------------------------------------------
  server.registerTool(
    'mukai_api_request',
    {
      description:
        'Call any Mukai backend API route directly (paths as in the Mukai server, e.g. "/bots", "/conversations/{id}/messages"). Use when no dedicated tool exists. The /settings/api token route is blocked.',
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().min(1).describe('Path starting with "/", without the /api prefix'),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.any().optional().describe('JSON body for non-GET requests'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ method, path, query, body }) => {
      try {
        const clean = '/' + path.replace(/^\/+/, '');
        if (/^\/settings\/api\/?(\?|$)/.test(clean)) throw new Error('Reading the backend API token through MCP is not allowed.');
        const response = await client.raw(method, clean, { query, body });
        const type = response.contentType;
        if (/json/.test(type) || !type) {
          const raw = response.bytes.toString('utf8');
          try {
            return text(JSON.parse(raw));
          } catch {
            return text(raw || 'OK');
          }
        }
        return binaryResult(response, clean);
      } catch (error) {
        return failure(error);
      }
    },
  );
}
