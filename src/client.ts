import { randomUUID } from 'node:crypto';

export interface MukaiClientOptions {
  /** e.g. http://127.0.0.1:47831 (direct backend) or https://host.example/api (served/browser mode). */
  baseUrl: string;
  token: string;
  /** Per-request timeout for ordinary (non-streaming) calls. */
  timeoutMs?: number;
}

export class MukaiApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RawResponse {
  status: number;
  contentType: string;
  filename?: string;
  bytes: Buffer;
}

export interface ChatResult {
  status: 'done' | 'error' | 'awaiting_approval' | 'timeout' | 'stream_closed';
  requestId: string;
  conversationId?: string;
  assistantMessageId?: string;
  text: string;
  error?: string | null;
  /** Assistant message IDs that reported a pending human decision. */
  approvalMessageIds: string[];
  activity: { tool?: string; action?: string; status?: string; title?: string }[];
  message?: unknown;
}

export class MukaiClient {
  private baseUrl: string;
  constructor(private options: MukaiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  url(path: string, query?: Query) {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : '/' + path));
    for (const [key, value] of Object.entries(query || {}))
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    return url;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // Never send an Origin header: Mukai accepts remote native clients only when
    // Origin is absent and the bearer token matches.
    return { Authorization: `Bearer ${this.options.token}`, ...extra };
  }

  async raw(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; rawBody?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<RawResponse> {
    const headers = this.headers(options.headers);
    let payload: BodyInit | undefined;
    if (options.rawBody) {
      payload = new Uint8Array(options.rawBody);
      headers['Content-Type'] ??= 'application/octet-stream';
    } else if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    } else if (!['GET', 'HEAD'].includes(method)) {
      // Several Mukai routes parse a JSON body even when every field is optional.
      payload = '{}';
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(this.url(path, options.query), {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';
    const disposition = response.headers.get('content-disposition') || '';
    const filename = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    if (!response.ok) {
      let detail: unknown = bytes.toString('utf8');
      try {
        detail = JSON.parse(String(detail));
      } catch {
        /* keep text */
      }
      const message =
        (detail && typeof detail === 'object' && 'error' in detail && String((detail as { error: unknown }).error)) ||
        `Mukai API returned HTTP ${response.status}`;
      throw new MukaiApiError(response.status, `${message} (HTTP ${response.status} ${method} ${path})`, detail);
    }
    return {
      status: response.status,
      contentType,
      filename: filename ? decodeURIComponent(filename) : undefined,
      bytes,
    };
  }

  async json<T = unknown>(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const response = await this.raw(method, path, options);
    const text = response.bytes.toString('utf8');
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  /**
   * Starts (or reattaches to) a streamed chat run and collects it until it
   * finishes, needs a human decision, or the wait budget runs out. Mukai runs are
   * backend-owned: disconnecting never cancels them, and re-posting the same
   * requestId reattaches to the existing run.
   */
  async chat(
    path: string,
    body: Record<string, unknown>,
    options: { waitSeconds: number; returnOnApproval: boolean; sendRequestId?: boolean },
  ): Promise<ChatResult> {
    const requestId = typeof body.requestId === 'string' ? body.requestId : randomUUID();
    const payload = options.sendRequestId === false ? body : { ...body, requestId };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.waitSeconds * 1000);
    const result: ChatResult = {
      status: 'stream_closed',
      requestId,
      text: '',
      approvalMessageIds: [],
      activity: [],
    };
    const activity = new Map<string, ChatResult['activity'][number]>();
    try {
      const response = await fetch(this.url(path), {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const text = await response.text();
        let message = text;
        try {
          message = JSON.parse(text).error ?? text;
        } catch {
          /* keep text */
        }
        throw new MukaiApiError(response.status, `${message} (HTTP ${response.status} POST ${path})`);
      }
      const decoder = new TextDecoder();
      let buffer = '';
      const handle = (line: string): boolean => {
        const trimmed = line.replace(/^data:\s*/, '').trim();
        if (!trimmed || trimmed.startsWith(':')) return false;
        let event: Record<string, any>;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return false;
        }
        switch (event.type) {
          case 'start':
            result.assistantMessageId = event.assistant?.id;
            result.conversationId = event.assistant?.conversationId ?? event.user?.conversationId;
            break;
          case 'delta':
            result.text += event.text ?? '';
            break;
          case 'activity':
            if (event.activity?.id)
              activity.set(event.activity.id, {
                tool: event.activity.tool,
                action: event.activity.action,
                status: event.activity.status,
                title: event.activity.title ?? event.activity.label,
              });
            break;
          case 'approval':
            // The event's id is the assistant message awaiting a decision, not the approval ID.
            if (event.id && !result.approvalMessageIds.includes(event.id))
              result.approvalMessageIds.push(event.id);
            if (options.returnOnApproval) {
              result.status = 'awaiting_approval';
              return true;
            }
            break;
          case 'done':
          case 'error':
            result.status = event.type;
            result.message = event.message;
            if (event.message?.content) result.text = event.message.content;
            result.error = event.message?.error ?? null;
            result.conversationId ??= event.message?.conversationId;
            return true;
        }
        return false;
      };
      const reader = response.body.getReader();
      outer: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (handle(line)) {
            controller.abort();
            break outer;
          }
        }
      }
      if (buffer) handle(buffer);
    } catch (error) {
      if (controller.signal.aborted && result.status === 'stream_closed') result.status = 'timeout';
      else if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
    }
    result.activity = [...activity.values()];
    return result;
  }
}
