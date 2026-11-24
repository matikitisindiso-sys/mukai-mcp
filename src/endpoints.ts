import { z, type ZodRawShape } from 'zod';

/**
 * Declarative map of Mukai backend routes (src/server/http/routes.ts and
 * telegramRoutes.ts in munashesydney/mukai) to MCP tools.
 *
 * Path params are written as {name}. Every input key that is not a path param
 * goes to the query string when listed in `query`, otherwise into the JSON body
 * (for non-GET methods). `bodyKey` sends one input value as the entire body.
 */
export interface Endpoint {
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  input?: ZodRawShape;
  query?: string[];
  bodyKey?: string;
  /** Response is a file/binary (images, downloads) rather than JSON. */
  binary?: boolean;
  destructive?: boolean;
}

// ---- Shared field schemas ---------------------------------------------------
const ws = z
  .string()
  .optional()
  .describe('Workspace ID. Omit for the "default" workspace. Use mukai_list_workspaces to find IDs.');
const id = (what: string) => z.string().min(1).describe(`${what} ID`);
const uuid = (what: string) => z.string().uuid().describe(`${what} ID (UUID)`);

export const avatars = [
  'mukai-logo',
  'muka-mascot-1-green',
  'muka-mascot-1-meroon',
  'muka-mascot-1-orange',
  'muka-mascot-1-purple',
  'muka-mascot-2-green',
  'muka-mascot-2-meroon',
  'muka-mascot-2-orange',
  'muka-mascot-2-purple',
  'muka-mascot-2-blue',
  'muka-mascot-3-blue',
  'muka-mascot-3-green',
  'muka-mascot-3-orange',
  'muka-mascot-3-purple',
  'muka-mascot-4-blue',
  'muka-mascot-5-blue',
] as const;
const reasoningLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const reasoningEfforts = ['provider-default', ...reasoningLevels] as const;

export const botFields = {
  name: z.string().min(1).max(60).describe('Bot name, e.g. "Ada"'),
  role: z.string().min(1).max(120).describe('Job title, e.g. "Code architect". Main bot uses "Main Bot/Orchestrator".'),
  instructions: z.string().min(1).max(12000).describe('System instructions for the bot'),
  providerId: z.string().uuid().nullable().describe('Provider connection ID, or null for the default provider'),
  model: z.string().min(1).max(150).nullable().describe('Exact model ID, or null for the provider default'),
  supportsImages: z.boolean().nullable().describe('Override image support, or null to inherit'),
  avatar: z.enum(avatars).describe('Avatar ID'),
  reasoningEffort: z.enum(reasoningEfforts).nullable().optional(),
  contextWindowTokens: z.number().int().min(4096).max(10000000).nullable().optional(),
  maxOutputTokens: z.number().int().min(256).max(262144).nullable().optional(),
};

const providerModel = z.object({
  id: z.string().min(1).max(150),
  name: z.string().min(1).max(150),
  contextWindowTokens: z.number().int().min(4096).max(10000000).nullable(),
  maxOutputTokens: z.number().int().min(256).max(262144),
  supportsImages: z.boolean(),
  supportsAudio: z.boolean().optional(),
  supportsVideo: z.boolean().optional(),
  responseTimeoutSeconds: z.number().int().min(1).max(7200).optional(),
  responseIdleTimeoutSeconds: z.number().int().min(1).max(7200).optional(),
  reasoningEffort: z.enum(reasoningEfforts).optional(),
  reasoningEfforts: z.array(z.enum(reasoningLevels)).max(7).optional(),
  customReasoning: z.object({ supportedEfforts: z.array(z.enum(reasoningLevels)).max(7) }).optional(),
});
const providerFields = {
  name: z.string().min(1).max(80),
  kind: z.enum(['openai', 'chatgpt', 'anthropic', 'google', 'compatible']),
  baseUrl: z.string().max(500).describe('Base URL (empty string for the provider default; required for "compatible")'),
  defaultModel: z.string().max(150).describe('Exact default model ID'),
  supportsImages: z.boolean(),
  supportsAudio: z.boolean().optional(),
  supportsVideo: z.boolean().optional(),
  isDefault: z.boolean().describe('Make this the default provider for bots without an explicit connection'),
  apiKey: z.string().max(4096).optional().describe('API key (omit to keep the saved key)'),
  clearKey: z.boolean().optional(),
  contextWindowTokens: z.number().int().min(4096).max(10000000).nullable().optional(),
  maxOutputTokens: z.number().int().min(256).max(262144).optional(),
  models: z.array(providerModel).max(200).optional(),
};

const followupAction = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('edit'),
    id: z.string().uuid(),
    text: z.string().max(16000),
    attachmentIds: z.array(z.string().uuid()).max(4).optional(),
  }),
  z.object({ action: z.enum(['delete', 'send']), id: z.string().uuid() }),
  z.object({ action: z.literal('steer'), id: z.string().uuid(), expectedRequestId: z.string().uuid() }),
]);
const followupInput = {
  id: z.string().uuid().optional().describe('Client-generated follow-up ID (UUID). Generated if omitted.'),
  text: z.string().max(16000).default(''),
  attachmentIds: z.array(z.string().uuid()).max(4).default([]),
};
const workpadTypes = ['work_item', 'decision', 'blocker', 'reference', 'note'] as const;
const workpadStatuses = ['todo', 'in_progress', 'done', 'open', 'resolved', 'active', 'archived'] as const;

// ---- Endpoints ----------------------------------------------------------------
export const endpoints: Endpoint[] = [
  // System
  { name: 'mukai_health', description: 'Check that the Mukai backend is up (version, uptime).', method: 'GET', path: '/health' },
  {
    name: 'mukai_get_ai_activity',
    description: 'Live AI queue snapshot: running/queued inference, working workspaces, pursuit runs and limits.',
    method: 'GET',
    path: '/ai-activity',
  },
  { name: 'mukai_get_limits', description: 'Get concurrency limits (pursuitConcurrency, aiConcurrency).', method: 'GET', path: '/limits' },
  {
    name: 'mukai_set_limits',
    description: 'Set shared concurrency limits.',
    method: 'PUT',
    path: '/limits',
    input: {
      pursuitConcurrency: z.number().int().min(1).max(50).optional(),
      aiConcurrency: z.number().int().min(1).optional(),
    },
  },

  // Workspaces
  { name: 'mukai_list_workspaces', description: 'List all workspaces.', method: 'GET', path: '/workspaces' },
  {
    name: 'mukai_create_workspace',
    description: 'Create a workspace from an absolute local folder path on the Mukai host (or a QEMU VM computer).',
    method: 'POST',
    path: '/workspaces',
    input: {
      name: z.string().min(1).max(60),
      folder: z.string().max(2000).default('').describe('Absolute folder path on the Mukai host (required for local)'),
      timeZone: z.string().optional().describe('IANA timezone, e.g. Africa/Harare'),
      computer: z.enum(['local', 'qemu']).default('local'),
    },
  },
  {
    name: 'mukai_update_workspace',
    description: 'Update a workspace (name, folder, timezone, computer).',
    method: 'PUT',
    path: '/workspaces/{workspaceId}',
    input: {
      workspaceId: id('Workspace'),
      name: z.string().min(1).max(60),
      folder: z.string().max(2000).default(''),
      timeZone: z.string().optional(),
      computer: z.enum(['local', 'qemu']).default('local'),
    },
  },
  {
    name: 'mukai_delete_workspace',
    description: 'Permanently delete a workspace. `name` must exactly match the workspace name as confirmation.',
    method: 'DELETE',
    path: '/workspaces/{workspaceId}',
    input: { workspaceId: id('Workspace'), name: z.string().describe('Exact workspace name (confirmation)') },
    destructive: true,
  },
  {
    name: 'mukai_set_workspace_timezone',
    description: 'Set a workspace timezone.',
    method: 'PUT',
    path: '/workspaces/{workspaceId}/timezone',
    input: { workspaceId: id('Workspace'), timeZone: z.string().describe('IANA timezone') },
  },
  {
    name: 'mukai_get_workspace_computer',
    description: 'Get the workspace computer status (local or QEMU VM state).',
    method: 'GET',
    path: '/workspaces/{workspaceId}/computer',
    input: { workspaceId: id('Workspace') },
  },
  {
    name: 'mukai_control_workspace_computer',
    description: 'Start or stop a workspace VM computer.',
    method: 'POST',
    path: '/workspaces/{workspaceId}/computer',
    input: { workspaceId: id('Workspace'), action: z.enum(['start', 'stop']) },
  },
  {
    name: 'mukai_set_workspace_computer_resources',
    description: 'Set VM memory/CPU for a workspace computer.',
    method: 'PUT',
    path: '/workspaces/{workspaceId}/computer-resources',
    input: {
      workspaceId: id('Workspace'),
      memoryMiB: z.number().int().min(1024).max(65536).multipleOf(256),
      vcpus: z.number().int().min(1).max(32),
    },
  },
  { name: 'mukai_get_computer_setup', description: 'Check whether VM computers are available/installed.', method: 'GET', path: '/workspaces/computer-setup' },
  { name: 'mukai_start_computer_setup', description: 'Start installing VM computer support.', method: 'POST', path: '/workspaces/computer-setup' },

  // Bots
  { name: 'mukai_list_bots', description: 'List bots in a workspace (IDs, names, roles, models, hierarchy).', method: 'GET', path: '/bots', input: { workspaceId: ws }, query: ['workspaceId'] },
  {
    name: 'mukai_create_bot',
    description: 'Create a bot. The selected provider/model connection is tested before saving.',
    method: 'POST',
    path: '/bots',
    input: { workspaceId: ws, ...botFields, avatar: botFields.avatar.default('mukai-logo'), providerId: botFields.providerId.default(null), model: botFields.model.default(null), supportsImages: botFields.supportsImages.default(null) },
  },
  {
    name: 'mukai_replace_bot',
    description: 'Replace all settings of a bot (full PUT). Prefer mukai_update_bot for partial changes.',
    method: 'PUT',
    path: '/bots/{botId}',
    input: { botId: id('Bot'), ...botFields },
  },
  { name: 'mukai_delete_bot', description: 'Delete a bot (delete its children first).', method: 'DELETE', path: '/bots/{botId}', input: { botId: id('Bot') }, destructive: true },
  {
    name: 'mukai_set_bot_model',
    description: "Change a bot's provider/model/reasoning effort for its next response.",
    method: 'PUT',
    path: '/bots/{botId}/model',
    input: {
      botId: id('Bot'),
      providerId: botFields.providerId,
      model: botFields.model,
      supportsImages: botFields.supportsImages.default(null),
      reasoningEffort: botFields.reasoningEffort,
      contextWindowTokens: botFields.contextWindowTokens,
    },
  },
  { name: 'mukai_get_bot_messages', description: "Get a bot's main private-chat message history.", method: 'GET', path: '/bots/{botId}/messages', input: { botId: id('Bot') } },
  { name: 'mukai_stop_bot', description: "Stop the bot's active main-chat response.", method: 'POST', path: '/bots/{botId}/stop', input: { botId: id('Bot') } },
  { name: 'mukai_list_bot_files', description: 'List files uploaded to a bot.', method: 'GET', path: '/bots/{botId}/files', input: { botId: id('Bot') } },
  { name: 'mukai_list_bot_artifacts', description: 'List artifacts (files) a bot created.', method: 'GET', path: '/bots/{botId}/artifacts', input: { botId: id('Bot') } },
  { name: 'mukai_list_bot_pending_attachments', description: 'List pending (not yet sent) attachments for a bot.', method: 'GET', path: '/bots/{botId}/attachments', input: { botId: id('Bot') } },
  { name: 'mukai_create_private_conversation', description: 'Start a new private conversation with a bot. Returns the conversation (use its id with mukai_send_conversation_message).', method: 'POST', path: '/bots/{botId}/conversations', input: { botId: id('Bot') } },
  { name: 'mukai_list_bot_followups', description: "List queued follow-up messages for a bot's main chat.", method: 'GET', path: '/bots/{botId}/followups', input: { botId: id('Bot') } },
  {
    name: 'mukai_queue_bot_followup',
    description: "Queue a follow-up message for a bot's main chat while it is working (use mukai_update_bot_followup with action 'steer' to apply it now).",
    method: 'POST',
    path: '/bots/{botId}/followups',
    input: { botId: id('Bot'), ...followupInput },
  },
  {
    name: 'mukai_update_bot_followup',
    description: "Edit, delete, send or steer a queued follow-up in a bot's main chat.",
    method: 'PUT',
    path: '/bots/{botId}/followups',
    input: { botId: id('Bot'), followup: followupAction },
    bodyKey: 'followup',
  },

  // Conversations / spaces
  {
    name: 'mukai_list_conversations',
    description: 'List conversations. kind: omit for spaces+all, "private" for private bot chats, "bot" for bot-to-bot threads, "history" for paginated history (limit/cursor).',
    method: 'GET',
    path: '/conversations',
    input: {
      workspaceId: ws,
      kind: z.enum(['private', 'bot', 'history']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(2048).optional(),
    },
    query: ['workspaceId', 'kind', 'limit', 'cursor'],
  },
  {
    name: 'mukai_create_space',
    description: 'Create a space (group conversation) with a set of bots.',
    method: 'POST',
    path: '/conversations',
    input: {
      workspaceId: z.string().min(1).max(80).default('default'),
      name: z.string().min(1).max(60),
      description: z.string().max(400).default(''),
      botIds: z.array(z.string()).max(50),
    },
  },
  {
    name: 'mukai_import_spaces',
    description: 'Import spaces with messages.',
    method: 'POST',
    path: '/conversations/import',
    input: {
      workspaceId: z.string().min(1).max(80).default('default'),
      spaces: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          messages: z.array(z.object({ id: z.string(), text: z.string(), author: z.string(), saved: z.boolean() })),
        }),
      ),
    },
  },
  { name: 'mukai_get_conversation', description: 'Get a conversation (kind, bots, metadata).', method: 'GET', path: '/conversations/{conversationId}', input: { conversationId: id('Conversation') } },
  { name: 'mukai_get_conversation_messages', description: 'Get the full message history of a conversation.', method: 'GET', path: '/conversations/{conversationId}/messages', input: { conversationId: id('Conversation') } },
  { name: 'mukai_stop_conversation', description: 'Stop the active response in a conversation.', method: 'POST', path: '/conversations/{conversationId}/stop', input: { conversationId: id('Conversation') } },
  { name: 'mukai_list_conversation_artifacts', description: 'List artifacts produced in a conversation.', method: 'GET', path: '/conversations/{conversationId}/artifacts', input: { conversationId: id('Conversation') } },
  { name: 'mukai_list_conversation_attachments', description: 'List pending attachments in a conversation.', method: 'GET', path: '/conversations/{conversationId}/attachments', input: { conversationId: id('Conversation') } },
  { name: 'mukai_list_conversation_outputs', description: 'List chat outputs (terminal sessions, servers, etc.) for a conversation.', method: 'GET', path: '/conversations/{conversationId}/outputs', input: { conversationId: id('Conversation') } },
  {
    name: 'mukai_get_conversation_terminal',
    description: 'Get a terminal session snapshot from a conversation.',
    method: 'GET',
    path: '/conversations/{conversationId}/terminal',
    input: { conversationId: id('Conversation'), sessionId: uuid('Terminal session') },
    query: ['sessionId'],
  },
  {
    name: 'mukai_open_conversation_output',
    description: 'Open a chat output (e.g. a served URL) by outputId.',
    method: 'POST',
    path: '/conversations/{conversationId}/open-output',
    input: { conversationId: id('Conversation'), outputId: uuid('Output') },
  },
  {
    name: 'mukai_get_conversation_trajectory',
    description: 'Get the raw model trajectory of a conversation. stats=true for summary stats; record=<n> for one record; from=<cursor> to page.',
    method: 'GET',
    path: '/conversations/{conversationId}/trajectory',
    input: {
      conversationId: id('Conversation'),
      stats: z.enum(['1']).optional().describe('Pass "1" for stats only'),
      record: z.number().int().positive().optional(),
      from: z.string().max(200).optional(),
    },
    query: ['stats', 'record', 'from'],
  },
  {
    name: 'mukai_set_message_saved',
    description: 'Save/unsave (bookmark) a message in a conversation.',
    method: 'PUT',
    path: '/conversations/{conversationId}/saved',
    input: { conversationId: id('Conversation'), messageId: z.string(), saved: z.boolean() },
  },
  { name: 'mukai_list_conversation_followups', description: 'List queued follow-ups for a conversation.', method: 'GET', path: '/conversations/{conversationId}/followups', input: { conversationId: id('Conversation') } },
  {
    name: 'mukai_queue_conversation_followup',
    description: 'Queue a follow-up message in a conversation while a bot is working. For spaces, botId selects the bot.',
    method: 'POST',
    path: '/conversations/{conversationId}/followups',
    input: { conversationId: id('Conversation'), ...followupInput, botId: z.string().optional() },
  },
  {
    name: 'mukai_update_conversation_followup',
    description: 'Edit, delete, send or steer a queued follow-up in a conversation.',
    method: 'PUT',
    path: '/conversations/{conversationId}/followups',
    input: { conversationId: id('Conversation'), followup: followupAction },
    bodyKey: 'followup',
  },
  {
    name: 'mukai_download_conversation_reference',
    description: 'Download a file referenced in a conversation (workspace path or URL href).',
    method: 'POST',
    path: '/conversations/{conversationId}/reference',
    input: { conversationId: id('Conversation'), href: z.string().min(1).max(4500), image: z.boolean().default(false) },
    binary: true,
  },
  {
    name: 'mukai_get_activity_image',
    description: 'Get an image a bot viewed during a response (by assistant messageId + activityId).',
    method: 'POST',
    path: '/conversations/{conversationId}/activity-image',
    input: { conversationId: id('Conversation'), messageId: z.string(), activityId: z.string() },
    binary: true,
  },
  { name: 'mukai_get_file_change', description: 'Get details/diff of a file change recorded during a response.', method: 'GET', path: '/changes/{changeId}', input: { changeId: id('Change') } },

  // Files
  { name: 'mukai_download_artifact', description: 'Download an artifact file by ID (images returned as images, text inline, other files base64).', method: 'GET', path: '/artifacts/{artifactId}', input: { artifactId: id('Artifact') }, binary: true },
  { name: 'mukai_download_attachment', description: 'Download an uploaded attachment by ID.', method: 'GET', path: '/attachments/{attachmentId}', input: { attachmentId: id('Attachment') }, binary: true },
  { name: 'mukai_delete_attachment', description: 'Delete an uploaded attachment.', method: 'DELETE', path: '/attachments/{attachmentId}', input: { attachmentId: id('Attachment') }, destructive: true },

  // Approvals
  {
    name: 'mukai_get_approvals',
    description: 'Get the approval mode and all pending tool approvals / bot questions in a workspace.',
    method: 'GET',
    path: '/approvals',
    input: { workspaceId: ws },
    query: ['workspaceId'],
  },
  {
    name: 'mukai_set_approval_mode',
    description: 'Set the workspace tool approval mode.',
    method: 'PUT',
    path: '/approvals',
    input: { workspaceId: ws, mode: z.enum(['ask-for-approval', 'full-access']) },
    query: ['workspaceId'],
  },
  {
    name: 'mukai_decide_approval',
    description: 'Approve or reject a pending tool call (approved + optional reason), or answer a bot question (answer). Provide either approved or answer.',
    method: 'POST',
    path: '/approvals/{approvalId}',
    input: {
      workspaceId: ws,
      approvalId: id('Approval'),
      approved: z.boolean().optional(),
      reason: z.string().min(1).max(16000).optional().describe('Rejection reason (only when approved=false)'),
      answer: z.string().min(1).max(16000).optional().describe('Answer to an ask/question request'),
    },
    query: ['workspaceId'],
  },
  {
    name: 'mukai_decide_approval_batch',
    description: 'Approve or reject a batch of grouped approvals at once.',
    method: 'POST',
    path: '/approvals/batch',
    input: {
      workspaceId: ws,
      conversationId: z.string().min(1),
      batchId: z.string().min(1),
      ids: z.array(z.string().uuid()).min(1).max(100),
      approved: z.boolean(),
    },
    query: ['workspaceId'],
  },

  // Providers
  { name: 'mukai_list_providers', description: 'List AI provider connections (keys never returned).', method: 'GET', path: '/providers' },
  { name: 'mukai_create_provider', description: 'Add an AI provider connection (OpenAI, Anthropic, Google, OpenAI-compatible).', method: 'POST', path: '/providers', input: providerFields },
  { name: 'mukai_update_provider', description: 'Update a provider connection (full settings).', method: 'PUT', path: '/providers/{providerId}', input: { providerId: uuid('Provider'), ...providerFields } },
  { name: 'mukai_delete_provider', description: 'Delete a provider connection.', method: 'DELETE', path: '/providers/{providerId}', input: { providerId: uuid('Provider') }, destructive: true },
  { name: 'mukai_test_provider', description: 'Test a provider connection (makes a small, possibly billable request).', method: 'POST', path: '/providers/{providerId}/test', input: { providerId: uuid('Provider') } },
  { name: 'mukai_list_provider_models', description: 'List models for a provider (catalog + saved models).', method: 'GET', path: '/providers/{providerId}/models', input: { providerId: uuid('Provider') } },
  {
    name: 'mukai_save_provider_models',
    description: "Replace a provider's saved model list and default model.",
    method: 'PUT',
    path: '/providers/{providerId}/models',
    input: { providerId: uuid('Provider'), defaultModel: z.string().max(150), models: z.array(providerModel).max(200) },
  },
  { name: 'mukai_disconnect_chatgpt', description: 'Disconnect a ChatGPT subscription provider (revokes tokens).', method: 'POST', path: '/providers/{providerId}/disconnect', input: { providerId: uuid('Provider') }, destructive: true },
  {
    name: 'mukai_begin_chatgpt_auth',
    description: 'Begin ChatGPT sign-in. Returns an attempt with an auth URL; sign-in must complete in a browser on the Mukai host (callback is on 127.0.0.1).',
    method: 'POST',
    path: '/providers/chatgpt-auth',
    input: { providerId: z.string().uuid().optional(), consent: z.boolean().optional(), retryAttemptId: z.string().uuid().optional() },
  },
  { name: 'mukai_get_chatgpt_auth_status', description: 'Get the status of a ChatGPT sign-in attempt.', method: 'GET', path: '/providers/chatgpt-auth/{attemptId}', input: { attemptId: id('Attempt') } },
  { name: 'mukai_cancel_chatgpt_auth', description: 'Cancel a ChatGPT sign-in attempt.', method: 'DELETE', path: '/providers/chatgpt-auth/{attemptId}', input: { attemptId: id('Attempt') } },

  // Pursuits
  { name: 'mukai_list_pursuits', description: 'List pursuits (long-running bot goals) in a workspace.', method: 'GET', path: '/pursuits', input: { workspaceId: ws }, query: ['workspaceId'] },
  {
    name: 'mukai_get_pursuit',
    description: 'Get pursuit details with paginated runs.',
    method: 'GET',
    path: '/pursuits/{pursuitId}',
    input: { pursuitId: id('Pursuit'), runLimit: z.number().int().min(1).max(100).optional(), runOffset: z.number().int().min(0).optional() },
    query: ['runLimit', 'runOffset'],
  },
  { name: 'mukai_delete_pursuit', description: 'Delete a pursuit.', method: 'DELETE', path: '/pursuits/{pursuitId}', input: { pursuitId: id('Pursuit') }, destructive: true },
  {
    name: 'mukai_set_pursuit_status',
    description: 'Pause or resume a pursuit.',
    method: 'PUT',
    path: '/pursuits/{pursuitId}/status',
    input: { pursuitId: id('Pursuit'), status: z.enum(['paused', 'active']) },
  },
  { name: 'mukai_run_pursuit_now', description: 'Trigger a pursuit run immediately.', method: 'POST', path: '/pursuits/{pursuitId}/run', input: { pursuitId: id('Pursuit') } },
  {
    name: 'mukai_get_pursuit_run',
    description: 'Get details of one pursuit run.',
    method: 'GET',
    path: '/pursuits/{pursuitId}/run',
    input: { pursuitId: id('Pursuit'), runId: uuid('Run') },
    query: ['runId'],
  },
  { name: 'mukai_retry_pursuit_run', description: 'Retry a failed pursuit run.', method: 'POST', path: '/pursuits/{pursuitId}/retry', input: { pursuitId: id('Pursuit'), runId: uuid('Run') } },
  {
    name: 'mukai_get_pursuit_workpad',
    description: "List a pursuit's workpad entries (work items, decisions, blockers, references, notes), or one entry by entryId.",
    method: 'GET',
    path: '/pursuits/{pursuitId}/workpad',
    input: {
      pursuitId: id('Pursuit'),
      entryId: z.string().uuid().optional(),
      type: z.enum(workpadTypes).optional(),
      status: z.enum(workpadStatuses).optional(),
      includeArchived: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
    },
    query: ['entryId', 'type', 'status', 'includeArchived', 'limit', 'offset'],
  },

  // Memory
  {
    name: 'mukai_get_memory',
    description: 'Get the workspace memory snapshot (facts, settings), optionally filtered by q, with history/asOf/paging.',
    method: 'GET',
    path: '/memory',
    input: {
      workspaceId: ws,
      q: z.string().max(2000).optional(),
      history: z.boolean().optional(),
      asOf: z.string().datetime({ offset: true }).optional(),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    query: ['workspaceId', 'q', 'history', 'asOf', 'page', 'limit'],
  },
  {
    name: 'mukai_search_memory',
    description: 'Search workspace memory (ranked recall hits).',
    method: 'GET',
    path: '/memory/search',
    input: {
      workspaceId: ws,
      q: z.string().max(2000),
      limit: z.number().int().min(1).max(100).optional(),
      history: z.boolean().optional(),
      uncertain: z.boolean().optional(),
      asOf: z.string().datetime({ offset: true }).optional(),
    },
    query: ['workspaceId', 'q', 'limit', 'history', 'uncertain', 'asOf'],
  },
  {
    name: 'mukai_get_memory_context',
    description: 'Get the exact memory context payload a bot turn would receive for a query.',
    method: 'GET',
    path: '/memory/context',
    input: { workspaceId: ws, q: z.string().max(2000), maxBytes: z.number().int().min(256).max(65536).optional() },
    query: ['workspaceId', 'q', 'maxBytes'],
  },
  { name: 'mukai_get_memory_fact', description: 'Get a memory fact with its source evidence.', method: 'GET', path: '/memory/{factId}', input: { workspaceId: ws, factId: id('Fact') }, query: ['workspaceId'] },
  {
    name: 'mukai_correct_memory_fact',
    description: 'Correct a memory fact.',
    method: 'POST',
    path: '/memory/{factId}/correct',
    input: {
      workspaceId: ws,
      factId: id('Fact'),
      text: z.string().min(1).max(1200),
      object: z.string().min(1).max(180),
      validFrom: z.string().datetime({ offset: true }).optional(),
    },
    query: ['workspaceId'],
  },
  { name: 'mukai_forget_memory_fact', description: 'Forget (delete) a memory fact.', method: 'DELETE', path: '/memory/{factId}', input: { workspaceId: ws, factId: id('Fact') }, query: ['workspaceId'], destructive: true },
  { name: 'mukai_forget_memory_episode', description: 'Forget a memory source episode and facts derived from it.', method: 'DELETE', path: '/memory/{episodeId}/episode', input: { workspaceId: ws, episodeId: id('Episode') }, query: ['workspaceId'], destructive: true },
  { name: 'mukai_retry_memory_item', description: 'Retry a failed memory capture (episode or run).', method: 'POST', path: '/memory/{itemId}/retry', input: { workspaceId: ws, itemId: id('Episode/run') }, query: ['workspaceId'] },
  { name: 'mukai_retry_memory_run', description: 'Retry a memory extraction run by ID.', method: 'POST', path: '/memory/runs/retry', input: { workspaceId: ws, id: uuid('Run') }, query: ['workspaceId'] },
  {
    name: 'mukai_save_memory_settings',
    description: 'Save workspace memory settings.',
    method: 'PUT',
    path: '/memory/settings',
    input: {
      workspaceId: ws,
      enabled: z.boolean(),
      automaticCapture: z.boolean(),
      automaticRecall: z.boolean(),
      semanticSearch: z.boolean(),
      contextTokens: z.number().int().min(256).max(4096),
    },
    query: ['workspaceId'],
  },
  { name: 'mukai_setup_memory_embeddings', description: 'Download & enable local embeddings for semantic memory search.', method: 'POST', path: '/memory/embeddings', input: { workspaceId: ws }, query: ['workspaceId'] },
  { name: 'mukai_export_memory', description: 'Export workspace memory as JSON.', method: 'GET', path: '/memory/export', input: { workspaceId: ws }, query: ['workspaceId'] },
  {
    name: 'mukai_import_memory',
    description: 'Import memory facts (version 1 export format).',
    method: 'POST',
    path: '/memory/import',
    input: {
      workspaceId: ws,
      version: z.literal(1).default(1),
      facts: z.array(
        z.object({
          subject: z.string(),
          relation: z.string(),
          object: z.string(),
          text: z.string(),
          validFrom: z.string(),
          validTo: z.string().nullable(),
          state: z.enum(['confirmed', 'uncertain']),
          ownerId: z.string().nullable().optional(),
        }),
      ),
    },
    query: ['workspaceId'],
  },
  {
    name: 'mukai_consolidate_memory',
    description: 'Fold duplicate memory claims. Reports only unless apply=true.',
    method: 'POST',
    path: '/memory/consolidate',
    input: { workspaceId: ws, apply: z.boolean().default(false), limit: z.number().int().min(1).max(1000).optional() },
    query: ['workspaceId'],
  },
  { name: 'mukai_clear_memory', description: 'Clear ALL memory in a workspace.', method: 'DELETE', path: '/memory', input: { workspaceId: ws }, query: ['workspaceId'], destructive: true },

  // Tools & custom capabilities
  { name: 'mukai_list_tools', description: 'List workspace tools with availability and usage counts.', method: 'GET', path: '/tools', input: { workspaceId: ws }, query: ['workspaceId'] },
  { name: 'mukai_get_tool_assignments', description: 'Get per-bot tool assignments.', method: 'GET', path: '/tools/assignments', input: { workspaceId: ws }, query: ['workspaceId'] },
  {
    name: 'mukai_set_tool_assignment',
    description: 'Enable/disable a tool for a bot.',
    method: 'PUT',
    path: '/tools/assignments',
    input: { workspaceId: ws, botId: z.string().min(1), toolId: z.string().min(1), enabled: z.boolean() },
    query: ['workspaceId'],
  },
  { name: 'mukai_list_capabilities', description: 'List custom tools, routes and jobs in a workspace.', method: 'GET', path: '/capabilities', input: { workspaceId: ws }, query: ['workspaceId'] },
  { name: 'mukai_get_capability', description: 'Get a custom capability registration with health.', method: 'GET', path: '/capabilities/{capabilityId}', input: { workspaceId: ws, capabilityId: id('Capability') }, query: ['workspaceId'] },
  {
    name: 'mukai_manage_capability',
    description:
      'Register/update/enable/disable/remove/list/inspect/set_permission/set_presentation/run_now a custom tool, route or job module (a .ts/.js file in the workspace).',
    method: 'POST',
    path: '/capabilities',
    input: {
      workspaceId: ws,
      kind: z.enum(['tool', 'route', 'job']),
      ownerBotId: z.string().optional(),
      operation: z.enum(['register', 'update', 'enable', 'disable', 'remove', 'list', 'inspect', 'set_permission', 'set_presentation', 'run_now']),
      id: z.string().max(100).optional(),
      modulePath: z.string().min(1).max(512).optional(),
      permissionMode: z.enum(['auto_approve', 'ask_bot', 'user_approval']).optional(),
      presentation: z.record(z.string(), z.any()).nullable().optional(),
      exportName: z.string().optional(),
    },
    query: ['workspaceId'],
  },
  {
    name: 'mukai_test_capability',
    description: 'Test a capability: tool -> pass tool input as `input`; route -> {headers, rawBody}; job -> runs now.',
    method: 'POST',
    path: '/capabilities/{capabilityId}/test',
    input: { workspaceId: ws, capabilityId: id('Capability'), input: z.record(z.string(), z.any()).default({}) },
    query: ['workspaceId'],
    bodyKey: 'input',
  },
  { name: 'mukai_get_route_settings', description: 'Get public custom-route domain settings.', method: 'GET', path: '/capabilities/settings' },
  {
    name: 'mukai_save_route_settings',
    description: 'Save public custom-route domain settings (e.g. {"publicBaseUrl": "https://..."}).',
    method: 'PUT',
    path: '/capabilities/settings',
    input: { settings: z.record(z.string(), z.any()) },
    bodyKey: 'settings',
  },
  { name: 'mukai_list_environment', description: 'List workspace environment variables (secret values are redacted).', method: 'GET', path: '/environment', input: { workspaceId: ws }, query: ['workspaceId'] },
  {
    name: 'mukai_save_environment',
    description: 'Save workspace environment variables (full list; omit value to keep an existing secret).',
    method: 'PUT',
    path: '/environment',
    input: {
      workspaceId: ws,
      entries: z
        .array(z.object({ name: z.string(), value: z.string().optional(), secret: z.boolean().optional(), originalName: z.string().optional() }))
        .max(200),
    },
    query: ['workspaceId'],
  },
  {
    name: 'mukai_set_environment_secret',
    description: 'Mark an environment variable secret or not.',
    method: 'PATCH',
    path: '/environment/{name}',
    input: { workspaceId: ws, name: z.string().describe('Variable name'), secret: z.boolean() },
    query: ['workspaceId'],
  },
  { name: 'mukai_delete_environment_variable', description: 'Delete a workspace environment variable.', method: 'DELETE', path: '/environment/{name}', input: { workspaceId: ws, name: z.string() }, query: ['workspaceId'], destructive: true },

  // Skills
  { name: 'mukai_list_skills', description: 'List workspace skills.', method: 'GET', path: '/skills', input: { workspaceId: ws, q: z.string().max(2000).optional() }, query: ['workspaceId', 'q'] },
  { name: 'mukai_get_skill', description: 'Inspect a skill (files, version).', method: 'GET', path: '/skills/{skillId}', input: { workspaceId: ws, skillId: id('Skill') }, query: ['workspaceId'] },
  { name: 'mukai_preview_skill', description: 'Preview a skill bundle from a URL (e.g. a GitHub folder).', method: 'POST', path: '/skills/preview', input: { workspaceId: ws, url: z.string().url().max(2000) }, query: ['workspaceId'] },
  {
    name: 'mukai_create_skill',
    description: 'Create a skill from a bundle of files (must include SKILL.md).',
    method: 'POST',
    path: '/skills',
    input: {
      workspaceId: ws,
      files: z.array(z.object({ path: z.string(), content: z.string(), encoding: z.enum(['utf8', 'base64']).default('utf8') })).min(1),
      source: z.object({ url: z.string(), repository: z.string(), commit: z.string(), folder: z.string() }).optional(),
    },
    query: ['workspaceId'],
  },
  {
    name: 'mukai_update_skill',
    description: 'Replace a skill bundle (expectedVersion from mukai_get_skill).',
    method: 'PUT',
    path: '/skills/{skillId}',
    input: {
      workspaceId: ws,
      skillId: id('Skill'),
      expectedVersion: z.string().length(64),
      bundle: z.object({
        files: z.array(z.object({ path: z.string(), content: z.string(), encoding: z.enum(['utf8', 'base64']).default('utf8') })).min(1),
        source: z.object({ url: z.string(), repository: z.string(), commit: z.string(), folder: z.string() }).optional(),
      }),
    },
    query: ['workspaceId'],
  },
  { name: 'mukai_set_skill_enabled', description: 'Enable or disable a skill.', method: 'PUT', path: '/skills/{skillId}/enabled', input: { workspaceId: ws, skillId: id('Skill'), enabled: z.boolean() }, query: ['workspaceId'] },
  { name: 'mukai_delete_skill', description: 'Delete a skill.', method: 'DELETE', path: '/skills/{skillId}', input: { workspaceId: ws, skillId: id('Skill') }, query: ['workspaceId'], destructive: true },

  // Browser
  { name: 'mukai_get_browser', description: 'Get browser sessions/tabs for a workspace.', method: 'GET', path: '/browser', input: { workspaceId: ws }, query: ['workspaceId'] },
  { name: 'mukai_browser_screenshot', description: 'Get a PNG screenshot of a browser session.', method: 'GET', path: '/browser/{sessionId}/screenshot', input: { sessionId: id('Browser session') }, binary: true },
  {
    name: 'mukai_browser_control',
    description: 'Control an existing browser tab: navigate, snapshot, click, type, press, scroll, back, forward, reload, screenshot, close.',
    method: 'POST',
    path: '/browser/{sessionId}/control',
    input: {
      sessionId: id('Browser session'),
      action: z.enum(['profiles', 'navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'back', 'forward', 'reload', 'screenshot', 'close']),
      url: z.string().max(4000).optional(),
      ref: z.string().max(100).optional().describe('Element ref from a snapshot'),
      text: z.string().max(16000).optional(),
      key: z.string().max(20).optional(),
      direction: z.enum(['up', 'down']).optional(),
      pixels: z.number().int().min(1).max(5000).optional(),
    },
  },

  // Notifications & failures
  {
    name: 'mukai_list_notifications',
    description: 'List notifications in a workspace.',
    method: 'GET',
    path: '/notifications',
    input: { workspaceId: ws, offset: z.number().int().min(0).optional() },
    query: ['workspaceId', 'offset'],
  },
  {
    name: 'mukai_update_notification',
    description: 'Mark a notification read, dismiss it, or continue it (resume the related work).',
    method: 'POST',
    path: '/notifications/{notificationId}/{action}',
    input: { workspaceId: ws, notificationId: id('Notification'), action: z.enum(['read', 'dismiss', 'continue']) },
    query: ['workspaceId'],
  },
  { name: 'mukai_dismiss_all_notifications', description: 'Dismiss all notifications in a workspace.', method: 'POST', path: '/notifications/dismiss-all', input: { workspaceId: ws }, query: ['workspaceId'] },
  { name: 'mukai_list_failures', description: 'List failed chats/pursuits (global Failed inbox).', method: 'GET', path: '/failures', input: { offset: z.number().int().min(0).optional() }, query: ['offset'] },
  { name: 'mukai_dismiss_failure', description: 'Dismiss one failure.', method: 'DELETE', path: '/failures/{failureId}', input: { failureId: id('Failure') } },
  { name: 'mukai_dismiss_all_failures', description: 'Dismiss all failures.', method: 'DELETE', path: '/failures' },

  // Settings
  { name: 'mukai_get_profile', description: 'Get the user profile settings.', method: 'GET', path: '/settings/profile' },
  { name: 'mukai_save_profile', description: 'Save user profile settings (pass the full profile object).', method: 'PUT', path: '/settings/profile', input: { profile: z.record(z.string(), z.any()) }, bodyKey: 'profile' },
  { name: 'mukai_get_appearance', description: 'Get appearance settings.', method: 'GET', path: '/settings/appearance' },
  { name: 'mukai_save_appearance', description: 'Save appearance settings (pass the full object).', method: 'PUT', path: '/settings/appearance', input: { appearance: z.record(z.string(), z.any()) }, bodyKey: 'appearance' },
  { name: 'mukai_get_updates', description: 'Get Mukai update status.', method: 'GET', path: '/settings/updates' },
  { name: 'mukai_set_automatic_updates', description: 'Enable/disable automatic updates.', method: 'PUT', path: '/settings/updates', input: { enabled: z.boolean() } },
  { name: 'mukai_check_updates', description: 'Check for Mukai updates now.', method: 'POST', path: '/settings/updates/check' },
  { name: 'mukai_restart_for_update', description: 'Restart Mukai to apply a downloaded update.', method: 'POST', path: '/settings/updates/restart', input: { confirm: z.literal(true) }, destructive: true },

  // Telegram
  { name: 'mukai_get_telegram', description: 'Get Telegram bot connection status.', method: 'GET', path: '/telegram' },
  { name: 'mukai_connect_telegram', description: 'Connect a Telegram bot by its BotFather token.', method: 'POST', path: '/telegram/connect', input: { token: z.string().describe('BotFather token, e.g. 123456:ABC...') } },
  { name: 'mukai_start_telegram_pairing', description: 'Start Telegram owner pairing (returns a pairing code).', method: 'POST', path: '/telegram/pairing' },
  { name: 'mukai_approve_telegram_pairing', description: 'Approve a Telegram pairing request.', method: 'POST', path: '/telegram/pairing/approve', input: { userId: z.number().int().positive().describe('Telegram user ID from the pairing request') } },
  {
    name: 'mukai_set_telegram_access',
    description: 'Set which workspaces (and default bot) Telegram can access.',
    method: 'PUT',
    path: '/telegram/access',
    input: { workspaces: z.array(z.object({ workspaceId: z.string(), botId: z.string().nullable() })).max(50) },
  },
  { name: 'mukai_set_telegram_state', description: 'Enable/pause the Telegram connection.', method: 'PUT', path: '/telegram/state', input: { enabled: z.boolean() } },
  { name: 'mukai_delete_telegram_connection', description: 'Remove the Telegram bot connection.', method: 'DELETE', path: '/telegram/connection', destructive: true },
  { name: 'mukai_delete_telegram_owner', description: 'Unpair the Telegram owner.', method: 'DELETE', path: '/telegram/owner', destructive: true },
];
