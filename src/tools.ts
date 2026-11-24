import { randomUUID } from 'node:crypto';
import { z, type ZodRawShape } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { MukaiApiError, type ChatResult, type MukaiClient, type Query, type RawResponse } from './client.js';
import { botFields, endpoints, type Endpoint } from './endpoints.js';
import {
  APPROVAL_TOOLS,
  SENSITIVE_TOOLS,
  UNTRUSTED_NOTICE,
  ConfirmationUnavailable,
  askHuman,
  audit,
  canElicit,
  confirmSensitive,
  redact,
  toolAllowed,
  type SecurityPolicy,
  type ToolMeta,
} from './security.js';
import {
  ACTION_CATEGORIES,
  APPROVAL_MODES,
  MODE_RANK,
  REQUEST_CATEGORIES,
  classifyAction,
  classifyRequest,
  type ActionCategory,
  type ApprovalMode,
  type PermissionStore,
  type RequestCategory,
} from './rules.js';

const MAX_INLINE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;

export interface ToolOptions {
  chatWaitSeconds: number;
  policy: SecurityPolicy;
  permissions: PermissionStore;
  sessionId?: () => string | undefined;
}

type Extra = { requestId: RequestId };
type Handler = (args: any, extra: Extra) => Promise<CallToolResult>;

/** Tool results that carry Mukai data are labelled as untrusted information. */
function text(value: unknown): CallToolResult {
  let body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (body === undefined) body = 'OK';
  if (body.length > MAX_TEXT_CHARS)
    body = body.slice(0, MAX_TEXT_CHARS) + `\n\n…[truncated ${body.length - MAX_TEXT_CHARS} characters]`;
  return { content: [{ type: 'text', text: `${UNTRUSTED_NOTICE}\n${body}` }] };
}

function failure(error: unknown): CallToolResult {
  const message =
    error instanceof MukaiApiError || error instanceof ConfirmationUnavailable
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
    else body = Object.fromEntries(Object.entries(args).filter(([key, value]) => !used.has(key) && value !== undefined));
  }
  return { path, query, body };
}

// ---- Approvals ----------------------------------------------------------------

interface PendingApproval {
  id: string;
  workspaceId: string;
  toolName?: string;
  input?: unknown;
  botName?: string;
  botId?: string;
  conversationId?: string;
  messageId?: string;
  batchId?: string;
  target?: { name?: string; kind?: string; workspaceId?: string };
  ask?: { action?: string; question?: string; options?: { label: string; description?: string }[] };
  createdAt?: string;
}

async function allPending(client: MukaiClient, workspaceId?: string): Promise<PendingApproval[]> {
  const ids = workspaceId
    ? [workspaceId]
    : ((await client.json<{ id: string }[]>('GET', '/workspaces').catch(() => [])) || []).map((item) => item.id);
  // Mukai may return the same pending request for every workspace queried, so
  // de-duplicate by ID and take the workspace from the request's own target.
  const found = new Map<string, PendingApproval>();
  for (const id of ids) {
    const state = await client
      .json<{ pending?: PendingApproval[] }>('GET', '/approvals', { query: { workspaceId: id } })
      .catch(() => undefined);
    for (const item of state?.pending || []) {
      const owner = item.target?.workspaceId ?? id;
      if (workspaceId && owner !== workspaceId) continue;
      if (!found.has(item.id)) found.set(item.id, { ...item, workspaceId: owner });
    }
  }
  return [...found.values()];
}

async function pendingForRun(client: MukaiClient, result: ChatResult) {
  if (!result.approvalMessageIds.length && result.status !== 'awaiting_approval') return [];
  return (await allPending(client)).filter(
    (item) =>
      result.approvalMessageIds.includes(String(item.messageId)) ||
      (result.conversationId && item.conversationId === result.conversationId),
  );
}

/** tool = a tool call waiting for permission; question = bot asks you something; yes_no = bot asks to proceed. */
export function approvalKind(item: PendingApproval): 'tool' | 'question' | 'yes_no' {
  if (item.ask?.action === 'clarification') return 'question';
  if (item.ask) return 'yes_no';
  return 'tool';
}

function describeApproval(item: PendingApproval) {
  const kind = approvalKind(item);
  const lines = [
    kind === 'question'
      ? 'A Mukai bot is asking you a question.'
      : kind === 'yes_no'
        ? 'A Mukai bot is asking for your go-ahead.'
        : 'A Mukai bot is waiting for your approval to use a tool.',
    `Bot: ${item.botName ?? item.botId ?? 'unknown'}`,
  ];
  if (item.target?.name) lines.push(`Conversation: ${item.target.name}`);
  if (item.ask) {
    lines.push('', `Question: ${item.ask.question ?? ''}`);
    item.ask.options?.forEach((option, index) =>
      lines.push(`${index + 1}. ${option.label}${option.description ? ' — ' + option.description : ''}`),
    );
  } else {
    let input = JSON.stringify(item.input ?? {}, null, 2);
    if (input.length > 4000) input = input.slice(0, 4000) + '\n…[truncated — open Mukai to review the full request]';
    lines.push(`Tool: ${item.toolName ?? 'unknown'}`, '', 'Request:', input);
  }
  lines.push('', '(Composed by the Mukai MCP server from Mukai’s own record of the request.)');
  return lines.join('\n');
}

/** Ask the human (not the model) to decide one approval, then apply the decision in Mukai. */
async function humanDecides(
  server: McpServer,
  client: MukaiClient,
  policy: SecurityPolicy,
  extra: Extra,
  item: PendingApproval,
  suggestion?: string,
) {
  const kind = approvalKind(item);
  const message = describeApproval(item) + (suggestion ? `\n\nThe AI assistant suggests: ${suggestion}` : '');
  const options = (item.ask?.options || []).map((option) => option.label);
  const result =
    kind === 'question'
      ? await askHuman(
          server,
          extra.requestId,
          policy,
          message,
          {
            ...(options.length ? { choice: { type: 'string', title: 'Pick a suggested answer', enum: options } } : {}),
            answer: { type: 'string', title: options.length ? 'Or type your own answer' : 'Your answer', maxLength: 16000 },
          },
          options.length ? [] : ['answer'],
        )
      : await askHuman(
          server,
          extra.requestId,
          policy,
          message,
          {
            decision: { type: 'string', title: 'Decision', enum: ['approve', 'reject'], enumNames: ['Approve', 'Reject'] },
            reason: { type: 'string', title: 'Reason (optional, sent to the bot when rejecting)', maxLength: 16000 },
          },
          ['decision'],
        );
  const content = (result.content || {}) as Record<string, unknown>;
  const answer = String(content.answer ?? '').trim() || String(content.choice ?? '').trim();
  if (result.action !== 'accept' || (kind === 'question' ? !answer : !content.decision)) {
    audit({ event: 'approval.human_skipped', approvalId: item.id, action: result.action });
    return { id: item.id, kind, decided: false as const, action: result.action };
  }
  const reason = String(content.reason ?? '').trim();
  const body =
    kind === 'question'
      ? { answer }
      : content.decision === 'approve'
        ? { approved: true }
        : { approved: false, ...(reason ? { reason } : {}) };
  const decision = kind === 'question' ? `answered: ${answer}` : String(content.decision);
  try {
    await client.json('POST', `/approvals/${encodeURIComponent(item.id)}`, { query: { workspaceId: item.workspaceId }, body });
  } catch (error) {
    // Someone decided it first (Mukai app, Telegram, another client): theirs stands.
    if (error instanceof MukaiApiError && error.status === 409) {
      audit({ event: 'approval.already_decided', approvalId: item.id });
      return { id: item.id, kind, decided: true as const, decision: 'already decided elsewhere' };
    }
    throw error;
  }
  audit({ event: 'approval.human_decided', approvalId: item.id, kind, decision: kind === 'question' ? 'answered' : decision });
  return { id: item.id, kind, decided: true as const, decision };
}

// ---- Registration -------------------------------------------------------------

export function registerTools(server: McpServer, client: MukaiClient, options: ToolOptions) {
  const { policy, permissions } = options;

  /** The workspace an action belongs to, for per-workspace action rules. */
  const actionWorkspace = async (args: any): Promise<string | undefined> => {
    if (typeof args?.workspaceId === 'string') return args.workspaceId;
    if (typeof args?.botId === 'string') {
      const workspaces = (await client.json<{ id: string }[]>('GET', '/workspaces').catch(() => [])) || [];
      for (const workspace of workspaces) {
        const bots = await client.json<{ id: string }[]>('GET', '/bots', { query: { workspaceId: workspace.id } }).catch(() => []);
        if ((bots || []).some((bot) => String(bot.id) === args.botId)) return workspace.id;
      }
    }
    return undefined; // falls back to the all-workspaces rules
  };

  /** Single choke point: policy filter, human confirmation, audit log. */
  const secure = (
    name: string,
    config: { description: string; inputSchema: ZodRawShape },
    meta: ToolMeta,
    handler: Handler,
  ) => {
    if (!toolAllowed(policy, name, meta)) return;
    const governed = classifyAction(name, {}, meta.destructive) ?? (name === 'mukai_api_request' ? 'raw-api' : undefined);
    const flags = [governed ? `Governed by MCP action rule "${governed}" (may need human confirmation).` : '', meta.destructive ? 'Destructive.' : '']
      .filter(Boolean)
      .join(' ');
    server.registerTool(
      name,
      {
        description: flags ? `${config.description}\n${flags}` : config.description,
        inputSchema: config.inputSchema,
        annotations: { readOnlyHint: meta.readOnly, destructiveHint: meta.destructive, openWorldHint: false },
      },
      async (args: any, extra: Extra) => {
        const started = Date.now();
        const base = { session: options.sessionId?.(), tool: name, args: redact(args) };
        try {
          const category = classifyAction(name, args, meta.destructive);
          if (category) {
            const workspaceId = await actionWorkspace(args);
            const rule = permissions.action(workspaceId, category);
            if (rule.decision === 'ask') {
              const summary = `Rule: actions.${category} = ask (${rule.source})\n` + JSON.stringify(redact(args), null, 2);
              const allowed = await confirmSensitive(server, extra.requestId, policy, name, summary);
              if (!allowed) {
                audit({ ...base, outcome: 'declined_by_human', rule: category });
                return failure(new Error('A human declined (or did not confirm) this action. Do not retry it unless they ask.'));
              }
            } else audit({ ...base, event: 'action.allowed_by_rule', rule: category, source: rule.source });
          }
          const result = await handler(args, extra);
          audit({ ...base, outcome: result.isError ? 'error' : 'ok', ms: Date.now() - started });
          return result;
        } catch (error) {
          audit({ ...base, outcome: 'error', error: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
          if (error instanceof ConfirmationUnavailable)
            return failure(
              new ConfirmationUnavailable(
                `${error.message} This action needs a human to confirm it, so it was not run. Do it in the Mukai app, or use an MCP client that supports confirmation prompts.`,
              ),
            );
          return failure(error);
        }
      },
    );
  };

  // ---- Plain endpoints ----
  for (const endpoint of endpoints) {
    if (APPROVAL_TOOLS.has(endpoint.name)) continue; // registered below with the approval policy
    secure(
      endpoint.name,
      { description: `${endpoint.description}\n[${endpoint.method} ${endpoint.path}]`, inputSchema: endpoint.input || {} },
      {
        readOnly: endpoint.method === 'GET',
        destructive: endpoint.destructive ?? false,
        sensitive: SENSITIVE_TOOLS.has(endpoint.name) || (endpoint.destructive ?? false),
      },
      async (args) => {
        const request = buildRequest(endpoint, args || {});
        if (endpoint.binary)
          return binaryResult(await client.raw(endpoint.method, request.path, { query: request.query, body: request.body }), endpoint.name);
        return text(await client.json(endpoint.method, request.path, { query: request.query, body: request.body }));
      },
    );
  }

  // ---- Who decides? -----------------------------------------------------------
  // The workspace's MCP mode sets the baseline and request rules adjust it per category:
  // ask-for-approval -> the human decides everything; full-access -> the AI decides tool
  // requests, questions stay with the human; i-own-it -> the AI decides everything.
  const categoryOf = (item: PendingApproval) => classifyRequest(item);
  const ruleFor = (item: PendingApproval) => permissions.request(item.workspaceId, categoryOf(item));
  const aiMayDecide = (item: PendingApproval) => ruleFor(item).decision === 'allow';
  const describePending = (item: PendingApproval, names?: Map<string, string>) => ({
    id: item.id,
    kind: approvalKind(item),
    category: categoryOf(item),
    decidedBy: aiMayDecide(item) ? 'ai' : 'human',
    because: ruleFor(item).source,
    workspaceId: item.workspaceId,
    workspaceName: names?.get(item.workspaceId),
    mcpApprovalMode: permissions.mode(item.workspaceId).mode,
    bot: item.botName ?? item.botId,
    conversation: item.target?.name,
    conversationId: item.conversationId,
    batchId: item.batchId,
    question: item.ask?.question,
    options: item.ask?.options?.map((option) => option.label),
    tool: item.ask ? undefined : item.toolName,
    input: item.ask ? undefined : redact(item.input),
    createdAt: item.createdAt,
  });

  /** Applies a decision the AI made itself — only ever reached when aiMayDecide(item). */
  const aiDecides = async (item: PendingApproval, approved?: boolean, reason?: string, answer?: string) => {
    const kind = approvalKind(item);
    let body: Record<string, unknown>;
    if (kind === 'question') {
      if (!answer?.trim()) throw new Error('This is a bot question: provide answer (one of the options or your own text).');
      body = { answer: answer.trim() };
    } else {
      if (approved === undefined) throw new Error('Provide approved=true or false.');
      body = approved ? { approved: true } : { approved: false, ...(reason ? { reason } : {}) };
    }
    try {
      await client.json('POST', `/approvals/${encodeURIComponent(item.id)}`, { query: { workspaceId: item.workspaceId }, body });
    } catch (error) {
      if (error instanceof MukaiApiError && error.status === 409)
        return { id: item.id, kind, decided: true, decision: 'already decided elsewhere' };
      throw error;
    }
    const decision = kind === 'question' ? `answered: ${body.answer}` : approved ? 'approve' : 'reject';
    audit({ event: 'approval.ai_decided', approvalId: item.id, workspaceId: item.workspaceId, category: categoryOf(item), decision, reason });
    return { id: item.id, kind, decided: true, decidedBy: 'ai', decision };
  };

  /** Routes one decision request according to the workspace mode and rules. */
  const decide = async (item: PendingApproval, extra: Extra, approved?: boolean, reason?: string, answer?: string) => {
    if (aiMayDecide(item)) return aiDecides(item, approved, reason, answer);
    const suggestion = answer ?? (approved === undefined ? undefined : approved ? 'approve' : `reject${reason ? ` (${reason})` : ''}`);
    try {
      return await humanDecides(server, client, options.policy, extra, item, suggestion);
    } catch (error) {
      if (error instanceof ConfirmationUnavailable) {
        const rule = ruleFor(item);
        throw new ConfirmationUnavailable(
          `Under requests.${categoryOf(item)} = ask (${rule.source}) the human must decide this. ` +
            'This client cannot show them a confirmation prompt; they can decide in Telegram or the Mukai app.',
        );
      }
      throw error;
    }
  };

  // ---- Everything waiting, wherever it started ----
  secure(
    'mukai_list_pending_approvals',
    {
      description:
        'List EVERYTHING waiting for a decision across all workspaces: tool approvals, bot questions and yes/no requests — ' +
        'whether they started in the Mukai app, Telegram, a pursuit, or this MCP server. Each item says decidedBy ' +
        '"ai" (you may decide it, under the workspace mode/rules) or "human", and why. Decide with mukai_decide_approval.',
      inputSchema: { workspaceId: z.string().optional().describe('Limit to one workspace') },
    },
    { readOnly: true, destructive: false, sensitive: false },
    async ({ workspaceId }) => {
      const workspaces = (await client.json<{ id: string; name: string }[]>('GET', '/workspaces').catch(() => [])) || [];
      const names = new Map(workspaces.map((item) => [item.id, item.name]));
      const items = await allPending(client, workspaceId);
      return text({ count: items.length, pending: items.map((item) => describePending(item, names)) });
    },
  );

  // ---- Modes and rules ----
  const scopeSchema = z
    .string()
    .min(1)
    .describe('Workspace ID, or "*" for every workspace');
  const checkScope = async (scope: string) => {
    if (scope === '*') return;
    const workspaces = (await client.json<{ id: string }[]>('GET', '/workspaces')) || [];
    if (!workspaces.some((item) => item.id === scope)) throw new Error('Unknown workspace.');
  };
  /** Loosening needs the human; tightening never does. */
  const confirmLoosening = async (extra: Extra, title: string, details: string) => {
    if (policy.sensitive === 'disable') throw new Error('Loosening permissions through MCP is disabled on this server; the operator sets them in MCP_RULES_FILE.');
    if (policy.sensitive === 'allow') return;
    const allowed = await confirmSensitive(server, extra.requestId, policy, title, details);
    if (!allowed) throw new Error('A human declined (or did not confirm) this change. Do not retry it unless they ask.');
  };

  secure(
    'mukai_get_mcp_permissions',
    {
      description:
        'Show the MCP permissions for a workspace: its mode (ask-for-approval / full-access / i-own-it), and for every category whether ' +
        'the AI may decide bot requests ("requests") and may act without confirmation ("actions"), with where each setting comes from. ' +
        "Also shows Mukai's own workspace mode. Omit workspaceId for the all-workspaces baseline.",
      inputSchema: { workspaceId: z.string().optional() },
    },
    { readOnly: true, destructive: false, sensitive: false },
    async ({ workspaceId }) => {
      const mukai = workspaceId
        ? await client.json<{ mode?: string }>('GET', '/approvals', { query: { workspaceId } }).catch(() => undefined)
        : undefined;
      const view = permissions.describe(workspaceId);
      const flat = (entries: Record<string, { decision: string; source: string; locked: boolean }>, catalog: Record<string, string>) =>
        Object.entries(entries).map(([category, rule]) => ({ category, meaning: catalog[category], ...rule }));
      return text({
        workspaceId: workspaceId ?? '* (all workspaces)',
        mcpMode: view.mode,
        mukaiApprovalMode: mukai?.mode,
        requests: flat(view.requests, REQUEST_CATEGORIES),
        actions: flat(view.actions, ACTION_CATEGORIES),
        legend: {
          requests: 'allow = the AI decides this kind of bot request; ask = the human decides',
          actions: 'allow = the AI may do this without confirmation; ask = the human confirms first',
          mukaiApprovalMode: 'Mukai’s own setting: whether bots ask at all (full-access there creates no approvals).',
        },
      });
    },
  );
  // Kept for compatibility: summary of modes per workspace.
  secure(
    'mukai_get_mcp_approval_mode',
    {
      description: 'Show the MCP approval mode of every workspace next to Mukai’s own mode. For per-category detail use mukai_get_mcp_permissions.',
      inputSchema: { workspaceId: z.string().optional() },
    },
    { readOnly: true, destructive: false, sensitive: false },
    async ({ workspaceId }) => {
      const workspaces = ((await client.json<{ id: string; name: string }[]>('GET', '/workspaces').catch(() => [])) || []).filter(
        (item) => !workspaceId || item.id === workspaceId,
      );
      const rows = [];
      for (const workspace of workspaces) {
        const state = await client.json<{ mode?: string }>('GET', '/approvals', { query: { workspaceId: workspace.id } }).catch(() => undefined);
        rows.push({ workspaceId: workspace.id, name: workspace.name, mcpApprovalMode: permissions.mode(workspace.id).mode, mukaiApprovalMode: state?.mode });
      }
      return text({ default: permissions.mode().mode, workspaces: rows });
    },
  );
  secure(
    'mukai_set_mcp_approval_mode',
    {
      description:
        'Set the MCP approval mode for a workspace (or "*" for all): ask-for-approval (human decides everything), full-access (AI decides ' +
        'bot tool requests; questions stay with the human), i-own-it (AI decides everything, questions and yes/no included), or "default". ' +
        'Making it more permissive needs human confirmation; making it stricter never does. Never decides requests already waiting.',
      inputSchema: { workspaceId: scopeSchema, mode: z.enum([...APPROVAL_MODES, 'default']) },
    },
    { readOnly: false, destructive: false, sensitive: false },
    async ({ workspaceId, mode }, extra) => {
      await checkScope(workspaceId);
      const scope = workspaceId === '*' ? undefined : workspaceId;
      const before = permissions.mode(scope);
      if (before.locked) throw new Error('The operator has locked the mode for this scope.');
      const previous = permissions.runtimeRules()[workspaceId]?.mode;
      permissions.setMode(workspaceId, mode);
      const outcome = permissions.mode(scope).mode;
      permissions.setMode(workspaceId, previous ?? 'default');
      if (MODE_RANK[outcome] > MODE_RANK[before.mode])
        await confirmLoosening(extra, 'mukai_set_mcp_approval_mode', `Workspace: ${workspaceId}\nMode: ${before.mode} → ${outcome}`);
      permissions.setMode(workspaceId, mode);
      const after = permissions.mode(scope);
      audit({ event: 'approval_mode.changed', workspaceId, from: before.mode, to: after.mode });
      return text({ workspaceId, mcpApprovalMode: after.mode, source: after.source });
    },
  );
  secure(
    'mukai_set_mcp_rule',
    {
      description:
        'Add or change a permission rule. kind "requests": may the AI decide this kind of bot request (allow) or must the human (ask)? ' +
        'kind "actions": may the AI do this itself without confirmation (allow) or must the human confirm (ask)? "default" removes the rule. ' +
        'Use mukai_get_mcp_permissions to see categories. Loosening (→ allow) needs human confirmation; tightening never does.',
      inputSchema: {
        workspaceId: scopeSchema,
        kind: z.enum(['requests', 'actions']),
        category: z.string().min(1).describe('A category name from mukai_get_mcp_permissions, e.g. "terminal" or "delete"'),
        decision: z.enum(['allow', 'ask', 'default']),
      },
    },
    { readOnly: false, destructive: false, sensitive: false },
    async ({ workspaceId, kind, category, decision }, extra) => {
      const catalog: Record<string, string> = kind === 'requests' ? REQUEST_CATEGORIES : ACTION_CATEGORIES;
      if (!(category in catalog))
        throw new Error(`Unknown ${kind} category "${category}". Valid: ${Object.keys(catalog).join(', ')}`);
      await checkScope(workspaceId);
      const scope = workspaceId === '*' ? undefined : workspaceId;
      const read = () =>
        kind === 'requests' ? permissions.request(scope, category as RequestCategory) : permissions.action(scope, category as ActionCategory);
      const before = read();
      if (before.locked) throw new Error(`The operator has locked ${kind}.${category} for this scope.`);
      // Work out the outcome first so that "default" counts as loosening when the default is allow.
      const previous = (permissions.runtimeRules()[workspaceId]?.[kind as "requests" | "actions"] as Record<string, string> | undefined)?.[category] as 'allow' | 'ask' | undefined;
      // Work out the outcome (so "default" counts as loosening when the default is allow), then
      // undo it while the human is asked, so a looser rule is never live before they confirm.
      permissions.setRule(workspaceId, kind, category, decision);
      const outcome = read();
      permissions.setRule(workspaceId, kind, category, previous ?? 'default');
      if (before.decision === 'ask' && outcome.decision === 'allow')
        await confirmLoosening(
          extra,
          'mukai_set_mcp_rule',
          `Workspace: ${workspaceId}\n${kind}.${category} (${catalog[category]}): ask → allow\n` +
            (kind === 'requests' ? 'The AI would decide these bot requests for you.' : 'The AI could do this without asking you.'),
        );
      permissions.setRule(workspaceId, kind, category, decision);
      const after = read();
      audit({ event: 'rule.changed', workspaceId, kind, category, from: before.decision, to: after.decision });
      return text({ workspaceId, kind, category, decision: after.decision, source: after.source });
    },
  );

  // ---- Approval decisions ----
  secure(
    'mukai_decide_approval',
    {
      description:
        'Decide a pending request (from mukai_list_pending_approvals or a chat result). Tool approvals: approved=true/false (+ optional reason). ' +
        'Questions: answer. If the item is decidedBy "ai" your decision is applied; if "human", the human gets a confirmation prompt showing ' +
        'Mukai’s record of the request and THEIR choice is applied — your values are only a suggestion.',
      inputSchema: {
        workspaceId: z.string().optional(),
        approvalId: z.string().min(1),
        approved: z.boolean().optional(),
        reason: z.string().min(1).max(16000).optional(),
        answer: z.string().min(1).max(16000).optional(),
      },
    },
    { readOnly: false, destructive: false, sensitive: false },
    async ({ workspaceId, approvalId, approved, reason, answer }, extra) => {
      const item = (await allPending(client, workspaceId)).find((entry) => entry.id === approvalId);
      if (!item) throw new Error('That request is not pending (it may already be decided in Mukai or Telegram).');
      return text(await decide(item, extra, approved, reason, answer));
    },
  );
  secure(
    'mukai_decide_approval_batch',
    {
      description:
        'Approve or reject several pending tool approvals at once. Items decidedBy "ai" are applied directly; the rest go to the human one by one.',
      inputSchema: {
        workspaceId: z.string().optional(),
        conversationId: z.string().min(1),
        batchId: z.string().min(1),
        ids: z.array(z.string().uuid()).min(1).max(100),
        approved: z.boolean(),
      },
    },
    { readOnly: false, destructive: false, sensitive: false },
    async ({ workspaceId, ids, approved }, extra) => {
      const items = (await allPending(client, workspaceId)).filter((entry) => ids.includes(entry.id));
      if (!items.length) throw new Error('None of those requests are pending.');
      const results = [];
      for (const item of items) results.push(await decide(item, extra, approved));
      return text(results);
    },
  );

  // ---- Chat (streamed run collected into one result) ----
  const chatWait = z
    .number()
    .int()
    .min(1)
    .max(3600)
    .default(options.chatWaitSeconds)
    .describe('Seconds to wait. The run keeps going on the server after this; re-call with the same requestId to reattach.');
  const approvalHandling = z
    .enum(['prompt', 'return', 'wait'])
    .default('prompt')
    .describe(
      'When the bot needs approval: "prompt" asks the human right here (if this client supports confirmation prompts), ' +
        '"return" returns immediately with the pending request, "wait" keeps waiting while the human decides in Mukai or Telegram.',
    );

  const hintFor = (status: ChatResult['status'], pending: PendingApproval[], prompted: boolean) => {
    if (pending.length) {
      const forAi = pending.filter(aiMayDecide).length;
      const forHuman = pending.length - forAi;
      const parts = [];
      if (forAi)
        parts.push(
          `${forAi} request(s) are yours to decide (decidedBy "ai"): call mukai_decide_approval with approved=true/false, or answer=... for questions. Decide in the human's interest and give a reason when rejecting.`,
        );
      if (forHuman)
        parts.push(
          (prompted ? 'The human did not decide every request in the prompt. ' : '') +
            `${forHuman} request(s) need the human (decidedBy "human"). They can decide in Telegram or the Mukai app` +
            (canElicit(server) ? ', or you can call mukai_decide_approval to show them a prompt here' : '') +
            '. Do not decide these yourself.',
        );
      parts.push('Then re-call with the same requestId to collect the rest of the reply.');
      return parts.join(' ');
    }
    if (status === 'timeout') return 'Wait budget expired; the bot is still working. Re-call with the same requestId to keep waiting.';
    if (status === 'stream_closed') return 'The stream closed before a final event. Check the conversation messages for the final state.';
    return undefined;
  };

  const runChat = async (
    path: string,
    body: Record<string, unknown>,
    waitSeconds: number,
    handling: 'prompt' | 'return' | 'wait',
    extra: Extra,
    reattachable: boolean,
  ) => {
    const deadline = Date.now() + waitSeconds * 1000;
    const decisions: unknown[] = [];
    let prompted = false;
    while (true) {
      const remaining = Math.max(1, Math.round((deadline - Date.now()) / 1000));
      const result = await client.chat(path, body, {
        waitSeconds: remaining,
        returnOnApproval: handling !== 'wait',
        sendRequestId: reattachable,
      });
      const pending = await pendingForRun(client, result);
      // Only requests the human must decide are prompted; the AI's own (full-access) ones go back to it.
      const forHuman = pending.filter((item) => !aiMayDecide(item));
      const canPrompt = handling === 'prompt' && canElicit(server);
      if (result.status === 'awaiting_approval' && forHuman.length && canPrompt && forHuman.length === pending.length) {
        prompted = true;
        let allDecided = true;
        for (const item of forHuman) {
          const outcome = await humanDecides(server, client, policy, extra, item);
          decisions.push(outcome);
          if (!outcome.decided) allDecided = false;
        }
        if (allDecided && reattachable && Date.now() < deadline) {
          body = { ...body, requestId: result.requestId }; // reattach to the same run
          continue;
        }
      }
      const { approvalMessageIds: _ids, ...rest } = result;
      const stillPending = decisions.length ? await pendingForRun(client, result) : pending;
      return text({
        ...rest,
        humanDecisions: decisions.length ? decisions : undefined,
        pendingApprovals: stillPending.map((item) => describePending(item)),
        hint: hintFor(result.status, stillPending, prompted),
      });
    }
  };

  secure(
    'mukai_chat_with_bot',
    {
      description:
        "Send a message to a bot's main chat and wait for its reply. Returns final text, tool activity and pending approvals. [POST /bots/{botId}/chat]",
      inputSchema: {
        botId: z.string().min(1),
        text: z.string().max(16000),
        attachmentIds: z.array(z.string().uuid()).max(4).default([]).describe('IDs from mukai_upload_attachment'),
        requestId: z.string().uuid().optional().describe('Reuse to reattach to an existing run; generated if omitted.'),
        waitSeconds: chatWait,
        approvalHandling,
      },
    },
    { readOnly: false, destructive: false, sensitive: false },
    async ({ botId, text: message, attachmentIds, requestId, waitSeconds, approvalHandling }, extra) =>
      runChat(
        `/bots/${encodeURIComponent(botId)}/chat`,
        { requestId: requestId || randomUUID(), text: message, attachmentIds },
        waitSeconds,
        approvalHandling,
        extra,
        true,
      ),
  );
  secure(
    'mukai_send_conversation_message',
    {
      description:
        'Send a message in a conversation (private chat, space, bot thread or pursuit run) and wait for the reply. For spaces, botId picks the responding bot. [POST /conversations/{conversationId}/chat]',
      inputSchema: {
        conversationId: z.string().min(1),
        text: z.string().max(16000),
        botId: z.string().nullable().default(null).describe('Spaces only: bot to respond'),
        attachmentIds: z.array(z.string().uuid()).max(4).default([]),
        requestId: z.string().uuid().optional(),
        waitSeconds: chatWait,
        approvalHandling,
      },
    },
    { readOnly: false, destructive: false, sensitive: false },
    async ({ conversationId, text: message, botId, attachmentIds, requestId, waitSeconds, approvalHandling }, extra) =>
      runChat(
        `/conversations/${encodeURIComponent(conversationId)}/chat`,
        { requestId: requestId || randomUUID(), text: message, botId, attachmentIds },
        waitSeconds,
        approvalHandling,
        extra,
        true,
      ),
  );
  secure(
    'mukai_retry_conversation_message',
    {
      description: 'Retry the latest failed/stopped/interrupted response in a conversation and wait for it. [POST /conversations/{conversationId}/retry]',
      inputSchema: {
        conversationId: z.string().min(1),
        messageId: z.string().uuid().describe('Assistant message ID to retry'),
        waitSeconds: chatWait,
        approvalHandling,
      },
    },
    { readOnly: false, destructive: false, sensitive: false },
    async ({ conversationId, messageId, waitSeconds, approvalHandling }, extra) =>
      // The retry body schema is strict (messageId only), so it cannot be reattached by requestId.
      runChat(`/conversations/${encodeURIComponent(conversationId)}/retry`, { messageId }, waitSeconds, approvalHandling, extra, false),
  );

  // ---- Uploads ----
  secure(
    'mukai_upload_attachment',
    {
      description:
        'Upload a file for a bot (or a specific private conversation) to attach to the next message. Returns the attachment (use its id in attachmentIds).',
      inputSchema: {
        botId: z.string().optional().describe('Upload to this bot (main chat). Provide botId or conversationId.'),
        conversationId: z.string().optional(),
        filename: z.string().min(1).max(255),
        content: z.string().describe('File content'),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
      },
    },
    { readOnly: false, destructive: false, sensitive: false },
    async ({ botId, conversationId, filename, content, encoding }) => {
      if (!botId && !conversationId) throw new Error('Provide botId or conversationId.');
      const path = conversationId
        ? `/conversations/${encodeURIComponent(conversationId)}/attachments`
        : `/bots/${encodeURIComponent(botId)}/attachments`;
      const response = await client.raw('POST', path, {
        rawBody: Buffer.from(content, encoding),
        headers: { 'X-Filename': encodeURIComponent(filename) },
      });
      return text(response.bytes.toString('utf8'));
    },
  );

  // ---- Partial bot update ----
  const partialBot = Object.fromEntries(Object.entries(botFields).map(([key, schema]) => [key, schema.optional()]));
  secure(
    'mukai_update_bot',
    {
      description: 'Update only the given fields of a bot (reads the current bot, merges, then PUTs). [PUT /bots/{botId}]',
      inputSchema: { botId: z.string().min(1), workspaceId: z.string().optional(), ...partialBot },
    },
    { readOnly: false, destructive: false, sensitive: false },
    async (args: Record<string, unknown>) => {
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
    },
  );

  // ---- Escape hatch (off unless MCP_ENABLE_RAW_API=true or profile "full") ----
  secure(
    'mukai_api_request',
    {
      description:
        'Call any Mukai backend API route directly (e.g. "/bots"). Use only when no dedicated tool exists. Non-GET calls require human confirmation; approval routes must go through mukai_decide_approval.',
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().min(1).describe('Path starting with "/", without the /api prefix'),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.any().optional(),
      },
    },
    { readOnly: false, destructive: true, sensitive: false },
    async ({ method, path, query, body }) => {
      const clean = '/' + String(path).replace(/^\/+/, '');
      if (method !== 'GET' && /^\/+approvals(\/|$)/i.test(clean))
        throw new Error('Approval decisions and modes must go through the dedicated tools, which enforce who decides.');
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
    },
  );
}
