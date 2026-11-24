# Mukai MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the **existing HTTP API** of
[Mukai](https://github.com/munashesydney/mukai) as tools. Deploy it anywhere that can reach your
Mukai backend, and any MCP client (Claude, Claude Code, Cursor, etc.) can drive the whole system:
workspaces, bots, chats and spaces, approvals, pursuits, memory, providers, skills, custom
tools/routes/jobs, the browser, notifications, Telegram and settings.

It doesn't change Mukai at all. Each tool turns into a call to one of Mukai's own routes
(`src/server/http/routes.ts` and `telegramRoutes.ts`), authenticated with Mukai's API token.

```
MCP client ──(Streamable HTTP + bearer)──▶ mukai-mcp ──(Bearer api.token)──▶ Mukai backend
```

See **[docs/MUKAI_API.md](docs/MUKAI_API.md)** for every Mukai route and its tool, and
**[docs/SECURITY.md](docs/SECURITY.md)** for the security model.

## Tools (143 by default, 56 in read-only, 144 in full)

| Area | Tools |
| --- | --- |
| Chat | `mukai_chat_with_bot`, `mukai_send_conversation_message`, `mukai_retry_conversation_message`, `mukai_stop_bot`, `mukai_stop_conversation`, follow-up queue/steer tools |
| Workspaces | list, create, update, delete, timezone, VM computer status/start/stop/resources/setup |
| Bots | list, create, `mukai_update_bot` (partial), replace, delete, set model, messages, files, artifacts, attachments, new private conversation |
| Conversations / spaces | list (private / bot / history), create space, import, get, messages, outputs, terminal, trajectory, artifacts, saved, references, activity images, file changes |
| Approvals | `mukai_list_pending_approvals` (everything waiting, from the app, Telegram, pursuits or MCP), approve/reject/answer, batch, Mukai's own mode, and MCP permissions: modes and rules per workspace (`mukai_get_mcp_permissions`, `mukai_set_mcp_approval_mode`, `mukai_set_mcp_rule`) |
| Providers | list, create, update, delete, test, models, ChatGPT sign-in/disconnect |
| Pursuits | list, get, delete, pause/resume, run now, run detail, retry, workpad |
| Memory | snapshot, search, context, fact get/correct/forget, episodes, settings, embeddings, import/export, consolidate, clear |
| Tools & capabilities | tool list + per-bot assignments, custom tool/route/job manage + test, route domain settings, environment variables |
| Skills | list, get, preview, create, update, enable, delete |
| Browser | sessions, screenshot, control (navigate/click/type/…) |
| Inbox | notifications (read/dismiss/continue), failures |
| Settings | profile, appearance, updates, limits, AI activity |
| Telegram | status, connect, pairing, access, enable, disconnect |
| Files | upload attachment, download artifact/attachment (images come back as images) |
| Escape hatch | `mukai_api_request`: any route without a dedicated tool. Off unless `MCP_ENABLE_RAW_API=true` |

### How chat and approvals work

Mukai streams chat replies. The chat tools read that stream and return the final text, the tool
activity, and any pending approvals in one result. Mukai runs live on the backend:
disconnecting never cancels a run, and sending the same `requestId` again reattaches to it.

When a bot needs approval, a **mode** per workspace decides who answers, and **rules** can
adjust it per category:
- **ask-for-approval** (the default): you decide everything.
- **full-access** (like Mukai's): Claude decides bot tool requests; questions stay with you.
- **i-own-it**: Claude decides everything, questions and yes/no included.

Rules such as "never approve terminal commands for me" or "Claude may delete in my sandbox" can
be set by you through Claude (loosening needs your confirmation) or by the operator in a
lockable rules file. Sensitive actions Claude takes itself (deleting, providers, custom code…)
need your confirmation in every mode unless a rule allows them. See
[docs/SECURITY.md](docs/SECURITY.md#two-kinds-of-permission).

In ask-for-approval:
- In clients that support MCP elicitation (confirmation prompts), the human gets a prompt built
  from Mukai's own record of the request. Their choice is applied and the tool waits for the
  rest of the reply.
- Requests raised **in the Mukai app** (tool approvals, questions with suggested answers, yes/no
  go-aheads) show up via `mukai_list_pending_approvals` and can be answered with
  `mukai_decide_approval` while you're away from your desk.
- Otherwise the result is `status: "awaiting_approval"` with `pendingApprovals`, and the human
  approves in **Telegram** or the Mukai app. Telegram receives every pending approval no matter
  who started the run, so MCP-triggered requests show up there too. Re-call with the same
  `requestId`, or use `approvalHandling: "wait"`, to collect the reply.

Sensitive actions (deletes, providers, custom code, skills, workspace folders, Telegram,
secrets, turning on full access) need the same kind of human confirmation. Details are in
[docs/SECURITY.md](docs/SECURITY.md).

## Setup

Requires Node.js 20+.

```sh
npm ci
npm run build
cp .env.example .env   # then fill in values; export them or use your platform's secret store
```

| Variable | Required | Description |
| --- | --- | --- |
| `MUKAI_API_URL` | yes | Mukai backend base URL. See below. |
| `MUKAI_CF_ACCESS_CLIENT_ID` / `MUKAI_CF_ACCESS_CLIENT_SECRET` | if Mukai is behind Cloudflare Access | Cloudflare Access service token. See below. |
| `MUKAI_API_TOKEN` | yes | Mukai API token. Find it in **Mukai → Settings → API**, or read it from the `api.token` file in the Mukai data directory (that file holds raw bytes; the token is their hex: `od -An -tx1 -v api.token \| tr -d ' \n'`). |
| `MCP_AUTH_TOKEN` | HTTP mode | Bearer token that clients must send to this server, at least 32 characters. Generate one with `openssl rand -hex 32`. |
| `PORT` / `HOST` | no | Listener address. Defaults to `3333` / `0.0.0.0`. |
| `MCP_ALLOWED_HOSTS` | no | Comma-separated allowlist for the `Host` header, which protects against DNS rebinding, e.g. `mcp.example.com`. |
| `MUKAI_CHAT_WAIT_SECONDS` | no | How long chat tools wait by default. Default `55`. Keep it below your client's tool timeout. |
| `MCP_APPROVAL_MODE`, `MCP_SENSITIVE_TOOLS`, `MCP_TOOL_PROFILE`, … | no | Security policy. Safe by default; see [docs/SECURITY.md](docs/SECURITY.md#configuration). |

### Mukai behind Cloudflare Zero Trust (Access)

If Mukai is protected by Cloudflare Access, give the MCP server a **service token**. It's a
deliberate, revocable key for this program; nothing is bypassed.

1. In Cloudflare Zero Trust: **Access → Service Auth → Create service token**. Copy the Client
   ID and Client Secret.
2. In Mukai's Access application, add a policy with action **Service Auth** that includes that
   token. Your login policy for people stays as it is.
3. Set `MUKAI_CF_ACCESS_CLIENT_ID` and `MUKAI_CF_ACCESS_CLIENT_SECRET`. The MCP server sends
   them on every request to Mukai, including streamed chats.

Notes:
- The server refuses to start if only one of the two is set, or if `MUKAI_API_URL` is plain
  HTTP to another machine (the token would travel unencrypted).
- If Access blocks a request, tools report "Blocked before reaching Mukai … check the service
  token / Service Auth policy". Redirects are never followed, so Cloudflare's login page is
  never mistaken for Mukai data.
- To cut off access, revoke the token in Cloudflare. Mukai's own API token is still required on
  top, so this is two locks rather than one.
- If the MCP server runs **on the same machine** as Mukai, you can skip Cloudflare entirely and
  use `http://127.0.0.1:47831`. That path never leaves the machine. Use the service token
  when they're on different machines, or everywhere if you want Cloudflare's off switch and
  logs.

### Choosing `MUKAI_API_URL`

- **MCP server on the same machine as Mukai** (Desktop, `npm run dev:server`, or `mukai serve`):
  `http://127.0.0.1:47831`. Run `mukai status` to see the real port.
- **MCP server somewhere else** (cloud, VPS): expose `mukai serve` through your HTTPS tunnel or
  reverse proxy, then use `https://your-mukai-domain/api`. The proxy must keep the original
  `Host` header. Mukai accepts these remote requests because they carry the bearer token and no
  browser `Origin` header, and the MCP server never sends one.

## Run

```sh
# Remote / Streamable HTTP (endpoint: POST /mcp, health: GET /health)
MUKAI_API_URL=... MUKAI_API_TOKEN=... MCP_AUTH_TOKEN=... npm start

# Local stdio (for a client that launches the process itself)
MUKAI_API_URL=... MUKAI_API_TOKEN=... node dist/index.js --stdio
```

Docker:

```sh
docker build -t mukai-mcp .
docker run -p 3333:3333 \
  -e MUKAI_API_URL=https://your-mukai-domain/api \
  -e MUKAI_API_TOKEN=... -e MCP_AUTH_TOKEN=... mukai-mcp
```

The HTTP transport keeps **sessions in memory**. That is what lets the human's answer to a
confirmation prompt reach the tool call that is waiting for it. Run **one instance**, or use
sticky sessions if you scale out. It runs on any container host (Fly.io, Railway, Render,
Cloud Run with session affinity, a VPS, …). Always put it behind HTTPS.

## Connect a client

**Claude Code**

```sh
claude mcp add --transport http mukai https://your-mcp-host/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

**Clients that only take a URL** (no custom headers): set `MCP_ALLOW_QUERY_TOKEN=true` and use
`https://your-mcp-host/mcp?token=<MCP_AUTH_TOKEN>`. A token in a URL can end up in logs, so use
the header wherever the client supports it.

**Claude Desktop / other stdio clients**

```json
{
  "mcpServers": {
    "mukai": {
      "command": "node",
      "args": ["/path/to/mukai-mcp/dist/index.js", "--stdio"],
      "env": { "MUKAI_API_URL": "http://127.0.0.1:47831", "MUKAI_API_TOKEN": "..." }
    }
  }
}
```

## Security

Safe by default: approvals and sensitive actions need a human, the raw API tool is off, results
are labelled as untrusted data, and paths are validated. On top of that, a strong token is
required, repeated auth failures lock the client out, and every call is written to an audit
log. Anyone holding `MCP_AUTH_TOKEN` still has owner-level access within those limits, so
treat it like a root password. The threat model and every setting are in
**[docs/SECURITY.md](docs/SECURITY.md)**.

## Tests

`test/e2e.mjs` runs against a real Mukai backend with a mock model (`test/mock-llm.mjs`).
It covers approve, reject, a dismissed prompt, model self-approval being blocked, approving
from outside MCP while the tool waits, answering app-raised questions/approvals via MCP, confirmation of sensitive actions, path traversal and
auth lockout.

```sh
node test/mock-llm.mjs &                     # fake OpenAI-compatible model on :11434
# start Mukai (npm run dev:server in the mukai repo) and this server (npm start), then:
MUKAI_API_URL=http://127.0.0.1:47831 MUKAI_API_TOKEN=... \
MCP_URL=http://127.0.0.1:3333/mcp MCP_AUTH_TOKEN=... TEST_FOLDER=/tmp/empty-dir \
node test/e2e.mjs
```

Unit tests for the permission rules (no backend needed): `npm test`.
Cloudflare Access test (fake Access gate in front of a real Mukai): `node test/cf-access.mjs` with
`MUKAI_API_URL`, `MUKAI_API_TOKEN` and `TEST_FOLDER`.

Run `node scripts/gen-api-doc.mjs` after changing `src/endpoints.ts` to regenerate the API
inventory.

## Not exposed as dedicated tools

These stay reachable through `mukai_api_request` where that makes sense:
- Push-device registration (`/push/*`). It needs a per-device session header.
- The VM desktop/audio view sessions. They are WebSocket streams for the UI.
- `GET /settings/api`. It returns the backend token, so it's blocked.
- `/environment/export`, a file download of secrets.
