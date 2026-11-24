import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import express, { type Request, type Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { FailureLimiter, audit } from './security.js';

/**
 * OAuth 2.1 for the MCP endpoint, so apps such as the Claude app can sign in the way MCP
 * expects: discovery metadata, dynamic client registration, authorization code + PKCE, a
 * human login page (the owner password), short-lived access tokens and rotating refresh tokens.
 *
 * Security choices:
 * - Only redirect URIs on an allowlist (Claude's hosts, plus loopback for local apps) can register.
 * - Tokens are random 256-bit values stored only as SHA-256 hashes; codes are single-use, 5 min.
 * - Refresh tokens rotate; reusing an old one revokes the whole sign-in (theft detection).
 * - Changing the owner password signs every app out.
 * - The login page cannot be framed, runs no scripts, and failed passwords lock out by IP.
 */

const ACCESS_TTL_S = 60 * 60; // 1 hour
const REFRESH_TTL_S = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

interface TokenRecord {
  kind: 'access' | 'refresh';
  clientId: string;
  family: string; // one sign-in; all tokens descending from one login
  scopes: string[];
  resource?: string;
  expiresAt: number;
  used?: boolean; // refresh tokens: already rotated
}
interface State {
  /** scrypt(password, fingerprintSalt): detects a changed password without storing it. */
  passwordFingerprint: string;
  fingerprintSalt: string;
  clients: Record<string, OAuthClientInformationFull>;
  tokens: Record<string, TokenRecord>; // keyed by sha256(token)
}
interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expires: number;
}
interface AuthorizationCode {
  clientId: string;
  params: AuthorizationParams;
  expires: number;
}

export interface OAuthOptions {
  publicUrl: URL; // e.g. https://mcp.example.com
  ownerPassword: string;
  stateFile: string;
  /** Hostnames allowed in https redirect URIs. Loopback http redirects are always allowed. */
  redirectHosts: string[];
}

export class MukaiOAuth implements OAuthServerProvider {
  private state: State;
  private pending = new Map<string, PendingAuthorization>();
  private codes = new Map<string, AuthorizationCode>();
  private loginFailures = new FailureLimiter(5, 15 * 60_000);
  private passwordHash: Buffer;
  private salt = randomBytes(16);
  readonly resourceUrl: URL;

  constructor(private options: OAuthOptions) {
    this.resourceUrl = new URL('/mcp', options.publicUrl);
    this.passwordHash = scryptSync(options.ownerPassword, this.salt, 32);
    let saved: State | undefined;
    try {
      saved = JSON.parse(readFileSync(options.stateFile, 'utf8')) as State;
    } catch {
      /* first start */
    }
    // A salted, slow fingerprint (never the password) tells us if the password changed.
    const fingerprintSalt = saved?.fingerprintSalt || randomBytes(16).toString('hex');
    const fingerprint = scryptSync(options.ownerPassword, Buffer.from(fingerprintSalt, 'hex'), 32).toString('hex');
    if (saved && saved.passwordFingerprint !== fingerprint) {
      audit({ event: 'oauth.password_changed', note: 'all OAuth sign-ins revoked' });
      saved.tokens = {};
    }
    this.state = { passwordFingerprint: fingerprint, fingerprintSalt, clients: saved?.clients ?? {}, tokens: saved?.tokens ?? {} };
    this.prune();
    this.save();
  }

  // ---- storage ----
  private save() {
    mkdirSync(dirname(this.options.stateFile), { recursive: true });
    const temporary = `${this.options.stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.options.stateFile);
  }
  private prune() {
    const cutoff = now() - 24 * 60 * 60; // keep expired records a day so they're recognised, not "unknown"
    for (const [hash, record] of Object.entries(this.state.tokens)) if (record.expiresAt < cutoff) delete this.state.tokens[hash];
    for (const [id, item] of this.pending) if (item.expires < Date.now()) this.pending.delete(id);
    for (const [id, item] of this.codes) if (item.expires < Date.now()) this.codes.delete(id);
  }

  // ---- clients (dynamic registration) ----
  private redirectAllowed(uri: string) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return false;
    }
    if (url.hash) return false;
    if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' && this.options.redirectHosts.includes(url.hostname.toLowerCase());
  }
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.state.clients[clientId],
      registerClient: (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
        const bad = (client.redirect_uris || []).filter((uri) => !this.redirectAllowed(String(uri)));
        if (!client.redirect_uris?.length || bad.length) {
          audit({ event: 'oauth.registration_refused', redirectUris: client.redirect_uris });
          throw new InvalidClientMetadataError(
            `Redirect URI not allowed: ${bad.join(', ') || '(none)'}. Allowed hosts: ${this.options.redirectHosts.join(', ')} (and localhost).`,
          );
        }
        if (Object.keys(this.state.clients).length >= 200) throw new InvalidClientMetadataError('Too many registered clients.');
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: now(),
        } as OAuthClientInformationFull;
        this.state.clients[full.client_id] = full;
        this.save();
        audit({ event: 'oauth.client_registered', clientId: full.client_id, name: client.client_name, redirectUris: client.redirect_uris });
        return full;
      },
    };
  }

  // ---- authorization: show the owner login page ----
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.prune();
    const id = secret();
    this.pending.set(id, { client, params, expires: Date.now() + PENDING_TTL_MS });
    res.status(200);
    this.page(res, loginPage(id, client, params));
  }

  private page(res: Response, html: string) {
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.send(html);
  }

  /** Express handler for the login form. */
  loginHandler() {
    const router = express.Router();
    router.post('/oauth/login', express.urlencoded({ extended: false, limit: '8kb' }), (req: Request, res: Response) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const pendingId = String(req.body?.pending || '');
      const item = this.pending.get(pendingId);
      if (!item || item.expires < Date.now()) {
        res.status(400);
        return this.page(res, messagePage('This sign-in link has expired. Go back to the app and connect again.'));
      }
      if (req.body?.action === 'deny') {
        this.pending.delete(pendingId);
        audit({ event: 'oauth.denied', clientId: item.client.client_id, client: ip });
        return res.redirect(302, withParams(item.params.redirectUri, { error: 'access_denied', state: item.params.state }));
      }
      if (this.loginFailures.blocked(ip)) {
        res.status(429);
        return this.page(res, messagePage('Too many wrong passwords. Try again in 15 minutes.'));
      }
      const given = scryptSync(String(req.body?.password || ''), this.salt, 32);
      if (!timingSafeEqual(given, this.passwordHash)) {
        this.loginFailures.fail(ip);
        audit({ event: 'oauth.login_failed', client: ip });
        res.status(401);
        return this.page(res, loginPage(pendingId, item.client, item.params, 'Wrong password.'));
      }
      this.loginFailures.succeed(ip);
      this.pending.delete(pendingId);
      const code = secret();
      this.codes.set(sha(code), { clientId: item.client.client_id, params: item.params, expires: Date.now() + CODE_TTL_MS });
      audit({ event: 'oauth.login_ok', clientId: item.client.client_id, name: item.client.client_name, client: ip });
      res.redirect(302, withParams(item.params.redirectUri, { code, state: item.params.state }));
    });
    return router;
  }

  // ---- codes and tokens ----
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const item = this.codes.get(sha(authorizationCode));
    if (!item || item.clientId !== client.client_id || item.expires < Date.now()) throw new InvalidGrantError('Invalid or expired authorization code.');
    return item.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = sha(authorizationCode);
    const item = this.codes.get(key);
    this.codes.delete(key); // single use, even on failure
    if (!item || item.clientId !== client.client_id || item.expires < Date.now()) throw new InvalidGrantError('Invalid or expired authorization code.');
    if (redirectUri && redirectUri !== item.params.redirectUri) throw new InvalidGrantError('redirect_uri does not match.');
    const requested = resource ?? item.params.resource;
    this.checkResource(requested);
    return this.issue(client.client_id, randomUUID(), item.params.scopes ?? [], requested?.href ?? this.resourceUrl.href);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const key = sha(refreshToken);
    const record = this.state.tokens[key];
    if (!record || record.kind !== 'refresh' || record.clientId !== client.client_id) throw new InvalidGrantError('Invalid refresh token.');
    if (record.used) {
      // A rotated refresh token came back: someone has a copy. End this whole sign-in.
      this.revokeFamily(record.family);
      audit({ event: 'oauth.refresh_reuse_detected', clientId: client.client_id, note: 'sign-in revoked' });
      throw new InvalidGrantError('Refresh token reuse detected; sign in again.');
    }
    if (record.expiresAt < now()) throw new InvalidGrantError('Refresh token expired; sign in again.');
    this.checkResource(resource);
    record.used = true;
    const granted = scopes?.length ? scopes.filter((scope) => record.scopes.includes(scope)) : record.scopes;
    return this.issue(client.client_id, record.family, granted, record.resource ?? this.resourceUrl.href);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.state.tokens[sha(token)];
    if (!record || record.kind !== 'access') throw new InvalidTokenError('Unknown access token.');
    if (record.expiresAt < now()) throw new InvalidTokenError('Access token expired.');
    if (!this.state.clients[record.clientId]) throw new InvalidTokenError('Client no longer registered.');
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  /** Distinguishes "expired but ours" (no lockout penalty) from "never issued" (counts as a failure). */
  known(token: string) {
    return !!this.state.tokens[sha(token)];
  }

  async revokeToken(client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    const record = this.state.tokens[sha(request.token)];
    if (record && record.clientId === client.client_id) this.revokeFamily(record.family);
  }

  /** Signs every app out (used by --revoke-oauth). */
  revokeAll() {
    this.state.tokens = {};
    this.save();
  }

  private revokeFamily(family: string) {
    for (const [hash, record] of Object.entries(this.state.tokens)) if (record.family === family) delete this.state.tokens[hash];
    this.save();
  }

  private checkResource(resource?: URL) {
    if (!resource) return;
    const normalized = (url: URL) => url.href.replace(/\/+$/, '');
    if (normalized(resource) !== normalized(this.resourceUrl) && normalized(resource) !== normalized(this.options.publicUrl))
      throw new InvalidGrantError(`Tokens here are only for ${this.resourceUrl.href}.`);
  }

  private issue(clientId: string, family: string, scopes: string[], resource: string): OAuthTokens {
    this.prune();
    const access = secret();
    const refresh = secret();
    this.state.tokens[sha(access)] = { kind: 'access', clientId, family, scopes, resource, expiresAt: now() + ACCESS_TTL_S };
    this.state.tokens[sha(refresh)] = { kind: 'refresh', clientId, family, scopes, resource, expiresAt: now() + REFRESH_TTL_S };
    this.save();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: scopes.join(' ') || undefined,
    };
  }
}

// ---- HTML ---------------------------------------------------------------------

const escape = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function withParams(uri: string, params: Record<string, string | undefined>) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

const styles = `
  :root { color-scheme: light dark; --bg:#f6f5f2; --card:#fff; --ink:#1d1c1a; --muted:#6b6862; --line:#e3e0da; --accent:#2f6b4f; --on-accent:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151514; --card:#1f1e1c; --ink:#f1efe9; --muted:#a6a29a; --line:#33312d; --accent:#6fbf98; --on-accent:#0d1f16; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--ink);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding:16px; }
  main { width:100%; max-width:400px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px; }
  h1 { font-size:20px; margin:0 0 4px; } p { margin:0 0 16px; color:var(--muted); }
  .who { border:1px solid var(--line); border-radius:10px; padding:12px; margin:0 0 18px; font-size:14px; }
  .who b { color:var(--ink); } label { display:block; font-size:14px; margin:0 0 6px; }
  input[type=password] { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:var(--ink); font-size:16px; }
  .row { display:flex; gap:10px; margin-top:16px; }
  button { flex:1; padding:10px; border-radius:8px; border:1px solid var(--line); font-size:15px; cursor:pointer; background:transparent; color:var(--ink); }
  button.primary { background:var(--accent); border-color:var(--accent); color:var(--on-accent); font-weight:600; }
  .error { color:#c0392b; font-size:14px; margin:8px 0 0; }
`;

function loginPage(pendingId: string, client: OAuthClientInformationFull, params: AuthorizationParams, error?: string) {
  const app = client.client_name || 'An app';
  const destination = new URL(params.redirectUri).host;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Mukai</title><style>${styles}</style></head><body><main>
<h1>Connect to Mukai</h1>
<p>Sign in as the owner to let this app use your Mukai through MCP.</p>
<div class="who"><b>${escape(app)}</b> wants access.<br>It will return to <b>${escape(destination)}</b>.<br>
It can do whatever your MCP permission rules allow.</div>
<form method="post" action="/oauth/login">
<input type="hidden" name="pending" value="${escape(pendingId)}">
<label for="password">Owner password</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
${error ? `<p class="error">${escape(error)}</p>` : ''}
<div class="row"><button type="submit" name="action" value="deny" formnovalidate>Deny</button>
<button class="primary" type="submit" name="action" value="allow">Allow</button></div>
</form></main></body></html>`;
}

function messagePage(message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mukai</title><style>${styles}</style></head><body><main><h1>Mukai</h1><p>${escape(message)}</p></main></body></html>`;
}
