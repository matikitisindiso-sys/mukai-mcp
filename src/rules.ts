import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * MCP permission model.
 *
 * MODES (per workspace) set the baseline for what the AI connected through MCP (e.g. Claude)
 * may decide on its own:
 *   ask-for-approval  the human decides every bot request              (Mukai's "Ask for approval")
 *   full-access       the AI decides bot TOOL requests; questions and   (Mukai's "Full access")
 *                     yes/no go-aheads still go to the human
 *   i-own-it          the AI decides every bot request, questions and yes/no included
 *
 * RULES adjust that baseline per category, in two families:
 *   requests  bot requests the AI may decide for you        ("allow" = the AI decides)
 *   actions   things the AI does itself through MCP tools   ("allow" = no confirmation needed)
 *
 * Rules come from two places:
 *   operator  MCP_RULES_FILE, written before deploying; entries can be locked
 *   runtime   set by the user through the AI (mukai_set_mcp_rule); loosening needs confirmation
 */
export const APPROVAL_MODES = ['ask-for-approval', 'full-access', 'i-own-it'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const MODE_RANK: Record<ApprovalMode, number> = { 'ask-for-approval': 0, 'full-access': 1, 'i-own-it': 2 };

export type Decision = 'allow' | 'ask';
export type RuleKind = 'requests' | 'actions';

/** Bot requests (approvals created by Mukai bots). */
export const REQUEST_CATEGORIES = {
  'files-read': 'Bot reads, lists or searches workspace files',
  'files-write': 'Bot creates a new file, edits part of a file, or creates a folder',
  'files-overwrite': 'Bot replaces the whole contents of an existing file',
  terminal: 'Bot runs terminal commands, processes or code',
  browser: "Bot uses the browser (opening pages, clicking, typing)",
  'computer-use': 'Bot controls the desktop (mouse, keyboard, screen)',
  web: 'Bot searches the web',
  bots: 'Bot creates, changes or messages other bots',
  pursuits: 'Bot creates or changes pursuits (scheduled goals)',
  'custom-code': 'Bot registers or changes custom tools, routes or jobs',
  'custom-tools': 'Bot calls a custom tool',
  other: 'Any other bot tool',
  questions: 'Bot asks you a question (with suggested answers)',
  'yes-no': 'Bot asks for a yes/no go-ahead (e.g. "May I publish?")',
} as const;
export type RequestCategory = keyof typeof REQUEST_CATEGORIES;

/** Things the AI does itself through MCP tools. */
export const ACTION_CATEGORIES = {
  delete: 'Delete or purge anything (bots, workspaces, memory, files, skills, attachments, pursuits)',
  providers: 'Add, change or disconnect AI providers (where prompts and files are sent)',
  'custom-code': 'Register, enable, test or change permissions of custom tools, routes and jobs',
  secrets: 'Change workspace environment variables and secrets',
  skills: 'Add, change or enable skills (they become bot instructions)',
  'memory-edit': 'Import or correct workspace memory',
  'workspace-setup': 'Create or re-point workspaces (which folders bots can touch)',
  telegram: 'Connect, pair, enable or disconnect Telegram',
  settings: "Tool assignments, limits, updates, restart, and switching Mukai's own mode to full access",
  'browser-control': 'Control an open browser tab directly (navigate, click, type)',
  'raw-api': 'Raw API calls that change something',
} as const;
export type ActionCategory = keyof typeof ACTION_CATEGORIES;

const TOOL_REQUESTS = new Set<RequestCategory>(
  (Object.keys(REQUEST_CATEGORIES) as RequestCategory[]).filter((key) => key !== 'questions' && key !== 'yes-no'),
);

/** Baseline for bot requests by mode. */
export function requestDefault(mode: ApprovalMode, category: RequestCategory): Decision {
  if (mode === 'i-own-it') return 'allow';
  if (mode === 'full-access') return TOOL_REQUESTS.has(category) ? 'allow' : 'ask';
  return 'ask';
}
/** Baseline for the AI's own actions by mode: sensitive actions ask in every mode. */
export function actionDefault(mode: ApprovalMode, category: ActionCategory, sensitivePolicy: 'confirm' | 'disable' | 'allow'): Decision {
  if (category === 'browser-control') return mode === 'ask-for-approval' ? 'ask' : 'allow';
  return sensitivePolicy === 'allow' ? 'allow' : 'ask';
}

/** Classifies a pending Mukai approval into a request category. */
export function classifyRequest(item: { toolName?: string; input?: any; ask?: { action?: string } }): RequestCategory {
  if (item.ask) return item.ask.action === 'clarification' ? 'questions' : 'yes-no';
  const tool = item.toolName || '';
  const action = item.input?.action;
  switch (tool) {
    case 'file_operations':
      if (['list', 'read_file', 'search_files'].includes(action)) return 'files-read';
      if (action === 'write_file' && item.input?.overwrite === true) return 'files-overwrite';
      return 'files-write';
    case 'terminal':
    case 'process':
    case 'execute_code':
      return 'terminal';
    case 'browser':
      return 'browser';
    case 'computer_use':
      return 'computer-use';
    case 'web_search':
      return 'web';
    case 'manage_bot':
      return 'bots';
    case 'manage_pursuit':
      return 'pursuits';
    case 'register_custom_tool':
    case 'register_custom_job':
    case 'register_custom_route':
    case 'confirm_custom_tool':
      return 'custom-code';
    case 'communicate':
    case 'conversations':
    case 'skills':
    case 'system':
    case 'media':
    case 'context':
    case 'image':
    case 'memory':
      return 'other';
    default:
      // Mukai's built-in tools are listed above; anything else is a registered custom tool.
      return tool ? 'custom-tools' : 'other';
  }
}

/** Maps MCP tools to the action category that governs them (undefined = not governed). */
const ACTION_TOOLS: Record<string, ActionCategory> = {
  mukai_create_provider: 'providers',
  mukai_update_provider: 'providers',
  mukai_save_provider_models: 'providers',
  mukai_begin_chatgpt_auth: 'providers',
  mukai_disconnect_chatgpt: 'providers',
  mukai_delete_provider: 'providers',
  mukai_manage_capability: 'custom-code',
  mukai_test_capability: 'custom-code',
  mukai_save_route_settings: 'custom-code',
  mukai_save_environment: 'secrets',
  mukai_set_environment_secret: 'secrets',
  mukai_delete_environment_variable: 'secrets',
  mukai_create_skill: 'skills',
  mukai_update_skill: 'skills',
  mukai_set_skill_enabled: 'skills',
  mukai_import_memory: 'memory-edit',
  mukai_correct_memory_fact: 'memory-edit',
  mukai_create_workspace: 'workspace-setup',
  mukai_update_workspace: 'workspace-setup',
  mukai_connect_telegram: 'telegram',
  mukai_approve_telegram_pairing: 'telegram',
  mukai_set_telegram_access: 'telegram',
  mukai_set_telegram_state: 'telegram',
  mukai_delete_telegram_connection: 'telegram',
  mukai_delete_telegram_owner: 'telegram',
  mukai_set_tool_assignment: 'settings',
  mukai_set_limits: 'settings',
  mukai_set_automatic_updates: 'settings',
  mukai_restart_for_update: 'settings',
  mukai_browser_control: 'browser-control',
};
export function classifyAction(tool: string, args: any, destructive: boolean): ActionCategory | undefined {
  if (tool === 'mukai_set_approval_mode') return args?.mode === 'full-access' ? 'settings' : undefined;
  if (tool === 'mukai_api_request') return args?.method && args.method !== 'GET' ? 'raw-api' : undefined;
  return ACTION_TOOLS[tool] ?? (destructive ? 'delete' : undefined);
}

// ---- Rule storage -------------------------------------------------------------

interface Scope {
  mode?: ApprovalMode;
  requests?: Partial<Record<RequestCategory, Decision>>;
  actions?: Partial<Record<ActionCategory, Decision>>;
  /** Operator file only: entries the AI/user cannot change at runtime ("mode", "requests.terminal", "actions.*", "*"). */
  locked?: string[];
}
type Scopes = Record<string, Scope>; // workspace ID, or "*" for every workspace

const isDecision = (value: unknown): value is Decision => value === 'allow' || value === 'ask';
const isMode = (value: unknown): value is ApprovalMode => (APPROVAL_MODES as readonly unknown[]).includes(value);

function cleanScopes(raw: unknown, allowLocks: boolean, origin: string): Scopes {
  const scopes: Scopes = {};
  if (!raw || typeof raw !== 'object') return scopes;
  for (const [scopeId, value] of Object.entries(raw as Record<string, any>)) {
    if (!value || typeof value !== 'object') continue;
    const scope: Scope = {};
    if (value.mode !== undefined) {
      if (!isMode(value.mode)) throw new Error(`${origin}: "${scopeId}.mode" must be one of ${APPROVAL_MODES.join(', ')}`);
      scope.mode = value.mode;
    }
    for (const kind of ['requests', 'actions'] as const) {
      const catalog = kind === 'requests' ? REQUEST_CATEGORIES : ACTION_CATEGORIES;
      if (!value[kind]) continue;
      scope[kind] = {};
      for (const [category, decision] of Object.entries(value[kind])) {
        if (!(category in catalog)) throw new Error(`${origin}: unknown ${kind} category "${category}" in "${scopeId}"`);
        if (!isDecision(decision)) throw new Error(`${origin}: "${scopeId}.${kind}.${category}" must be "allow" or "ask"`);
        (scope[kind] as Record<string, Decision>)[category] = decision;
      }
    }
    if (allowLocks && Array.isArray(value.locked)) scope.locked = value.locked.map(String);
    scopes[scopeId] = scope;
  }
  return scopes;
}

export interface Resolution {
  decision: Decision;
  source: string;
  locked: boolean;
}

export class PermissionStore {
  private operator: Scopes;
  private runtime: Scopes = {};

  constructor(
    private stateFile: string,
    private fallbackMode: ApprovalMode,
    rulesFile: string | undefined,
    private sensitivePolicy: 'confirm' | 'disable' | 'allow',
  ) {
    this.operator = {};
    if (rulesFile) {
      const parsed = JSON.parse(readFileSync(rulesFile, 'utf8'));
      this.operator = cleanScopes(parsed.workspaces ?? parsed, true, rulesFile);
    }
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
      this.runtime = cleanScopes(saved.runtime, false, stateFile);
      // Earlier format: { approvalModes: { workspaceId: mode } }
      for (const [id, mode] of Object.entries(saved.approvalModes || {}))
        if (isMode(mode)) (this.runtime[id] ??= {}).mode ??= mode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }

  private locked(scope: Scope | undefined, key: string) {
    const [kind] = key.split('.');
    return !!scope?.locked?.some((entry) => entry === '*' || entry === key || entry === `${kind}.*`);
  }

  /** Layers, highest priority first. Locked operator entries shut out runtime layers. */
  private resolveKey<T>(workspaceId: string | undefined, key: string, read: (scope: Scope) => T | undefined) {
    const ws = workspaceId && workspaceId !== '*' ? workspaceId : undefined;
    const opWs = ws ? this.operator[ws] : undefined;
    const opAll = this.operator['*'];
    const lockedBy = this.locked(opWs, key) ? 'operator (this workspace, locked)' : this.locked(opAll, key) ? 'operator (all workspaces, locked)' : undefined;
    const layers: [string, Scope | undefined][] = lockedBy
      ? [
          ['operator (this workspace, locked)', opWs],
          ['operator (all workspaces, locked)', opAll],
        ]
      : [
          ['your rule (this workspace)', ws ? this.runtime[ws] : undefined],
          ['your rule (all workspaces)', this.runtime['*']],
          ['operator (this workspace)', opWs],
          ['operator (all workspaces)', opAll],
        ];
    for (const [source, scope] of layers) {
      const value = scope ? read(scope) : undefined;
      if (value !== undefined) return { value, source, locked: !!lockedBy };
    }
    return { value: undefined, source: lockedBy ?? 'default', locked: !!lockedBy };
  }

  mode(workspaceId?: string): { mode: ApprovalMode; source: string; locked: boolean } {
    const found = this.resolveKey(workspaceId, 'mode', (scope) => scope.mode);
    return { mode: found.value ?? this.fallbackMode, source: found.value ? found.source : 'default', locked: found.locked };
  }

  request(workspaceId: string | undefined, category: RequestCategory): Resolution {
    const found = this.resolveKey(workspaceId, `requests.${category}`, (scope) => scope.requests?.[category]);
    if (found.value) return { decision: found.value, source: found.source, locked: found.locked };
    const mode = this.mode(workspaceId).mode;
    return { decision: requestDefault(mode, category), source: `mode ${mode}`, locked: found.locked };
  }

  action(workspaceId: string | undefined, category: ActionCategory): Resolution {
    const found = this.resolveKey(workspaceId, `actions.${category}`, (scope) => scope.actions?.[category]);
    if (found.value) return { decision: found.value, source: found.source, locked: found.locked };
    const mode = this.mode(workspaceId).mode;
    return { decision: actionDefault(mode, category, this.sensitivePolicy), source: `mode ${mode}`, locked: found.locked };
  }

  /** Full picture for one scope, for display. */
  describe(workspaceId?: string) {
    const requests = Object.fromEntries(
      (Object.keys(REQUEST_CATEGORIES) as RequestCategory[]).map((category) => [category, this.request(workspaceId, category)]),
    );
    const actions = Object.fromEntries(
      (Object.keys(ACTION_CATEGORIES) as ActionCategory[]).map((category) => [category, this.action(workspaceId, category)]),
    );
    return { mode: this.mode(workspaceId), requests, actions };
  }

  setMode(scopeId: string, mode: ApprovalMode | 'default') {
    if (this.mode(scopeId === '*' ? undefined : scopeId).locked) throw new Error('The operator has locked the mode for this scope.');
    const scope = (this.runtime[scopeId] ??= {});
    if (mode === 'default') delete scope.mode;
    else scope.mode = mode;
    this.save();
  }

  setRule(scopeId: string, kind: RuleKind, category: string, decision: Decision | 'default') {
    const ws = scopeId === '*' ? undefined : scopeId;
    const current = kind === 'requests' ? this.request(ws, category as RequestCategory) : this.action(ws, category as ActionCategory);
    if (current.locked) throw new Error(`The operator has locked ${kind}.${category} for this scope.`);
    const scope = (this.runtime[scopeId] ??= {});
    const rules = (scope[kind] ??= {}) as Record<string, Decision>;
    if (decision === 'default') delete rules[category];
    else rules[category] = decision;
    this.save();
  }

  private save() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ runtime: this.runtime }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.stateFile);
  }

  runtimeRules() {
    return structuredClone(this.runtime);
  }
  operatorRules() {
    return structuredClone(this.operator);
  }
}
