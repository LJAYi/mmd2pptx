import type {
  BrokerEnv,
  CollectionPage,
  GitHubTokenSet,
  InstallationItem,
  StoredSession,
} from "./contracts";
import {
  decryptTokenSet,
  encryptTokenSet,
  isPkceChallenge,
  randomToken,
  sha256Base64Url,
} from "./crypto";
import { AuthSessionObject, OAuthTransactionObject } from "./durable-objects";
import { GitHubClient } from "./github";
import { BrokerProblem, problemResponse } from "./problem";

export { AuthSessionObject, OAuthTransactionObject };

const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const sessionIdleMs = 30 * 60 * 1000;
const refreshWindowMs = 5 * 60 * 1000;
const maxJsonBodyBytes = 4096;

interface BrokerConfig {
  allowedOrigins: Set<string>;
  brokerPublicUrl: string;
  githubAppSlug: string;
}

interface InternalExchange {
  authorizationCode: string;
  returnOrigin: string;
}

interface InternalCompletion {
  exchangeCode: string;
  returnOrigin: string;
}

function configFromEnv(env: BrokerEnv): BrokerConfig {
  const allowedOrigins = new Set(
    env.ALLOWED_ORIGINS.split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const url = new URL(value);
        if (url.origin !== value || url.username || url.password) {
          throw new Error("ALLOWED_ORIGINS must contain exact origins");
        }
        return url.origin;
      }),
  );
  const broker = new URL(env.BROKER_PUBLIC_URL);
  const isLocal = broker.hostname === "localhost" || broker.hostname === "127.0.0.1";
  if ((broker.protocol !== "https:" && !(isLocal && broker.protocol === "http:")) || broker.pathname !== "/") {
    throw new Error("BROKER_PUBLIC_URL must be an HTTPS origin or local HTTP origin");
  }
  if (
    !env.GITHUB_APP_CLIENT_ID ||
    !env.GITHUB_APP_CLIENT_SECRET ||
    !env.GITHUB_APP_SLUG ||
    !env.SESSION_ENCRYPTION_KEY ||
    allowedOrigins.size === 0
  ) {
    throw new Error("Required broker configuration is missing");
  }
  return {
    allowedOrigins,
    brokerPublicUrl: broker.origin,
    githubAppSlug: env.GITHUB_APP_SLUG,
  };
}

function githubClient(env: BrokerEnv, config: BrokerConfig): GitHubClient {
  return new GitHubClient({
    apiBaseUrl: env.GITHUB_API_BASE_URL,
    oauthBaseUrl: env.GITHUB_OAUTH_BASE_URL,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    brokerPublicUrl: config.brokerPublicUrl,
  });
}

function requestOrigin(request: Request, config: BrokerConfig): string {
  const origin = request.headers.get("Origin");
  if (!origin || !config.allowedOrigins.has(origin)) {
    throw new BrokerProblem(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed");
  }
  return origin;
}

async function enforceRateLimit(binding: RateLimit, key: string): Promise<void> {
  const outcome = await binding.limit({ key });
  if (!outcome.success) {
    throw new BrokerProblem(429, "BROKER_RATE_LIMITED", "Too many requests; try again later");
  }
}

async function enforceSessionRateLimit(env: BrokerEnv, handle: string): Promise<void> {
  await enforceRateLimit(env.SESSION_RATE_LIMITER, await sha256Base64Url(handle));
}

function jsonResponse(value: unknown, origin?: string, status = 200): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return Response.json(value, { status, headers });
}

async function smallJson<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > maxJsonBodyBytes) {
    throw new BrokerProblem(413, "REQUEST_TOO_LARGE", "Request body is too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxJsonBodyBytes) {
    throw new BrokerProblem(413, "REQUEST_TOO_LARGE", "Request body is too large");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BrokerProblem(400, "INVALID_REQUEST", "Request body must be valid JSON");
  }
}

function transactionStub(env: BrokerEnv, state: string): DurableObjectStub {
  return env.OAUTH_TRANSACTIONS.get(env.OAUTH_TRANSACTIONS.idFromName(state));
}

function sessionStub(env: BrokerEnv, handle: string): DurableObjectStub {
  return env.AUTH_SESSIONS.get(env.AUTH_SESSIONS.idFromName(handle));
}

async function internalJson<T>(response: Response, fallbackCode: string): Promise<T> {
  const value = (await response.json()) as { code?: string } & T;
  if (response.ok) return value;
  const code = value.code ?? fallbackCode;
  if (code === "TRANSACTION_EXPIRED" || code === "TRANSACTION_NOT_READY") {
    throw new BrokerProblem(401, "SESSION_EXPIRED", "GitHub authorization has expired");
  }
  if (code === "TRANSACTION_REPLAYED" || code === "PKCE_MISMATCH") {
    throw new BrokerProblem(401, code, "GitHub authorization could not be verified");
  }
  if (code === "SESSION_REQUIRED") {
    throw new BrokerProblem(401, code, "Sign in with GitHub to continue");
  }
  if (code === "INVALID_CURSOR") {
    throw new BrokerProblem(400, code, "The collection cursor is invalid or expired");
  }
  throw new BrokerProblem(502, fallbackCode, "The authentication service is temporarily unavailable");
}

function parseBearer(request: Request): string {
  const authorization = request.headers.get("Authorization");
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization ?? "");
  if (!match?.[1]) throw new BrokerProblem(401, "SESSION_REQUIRED", "Sign in with GitHub to continue");
  return match[1];
}

async function loadSession(env: BrokerEnv, handle: string): Promise<StoredSession> {
  const response = await sessionStub(env, handle).fetch("https://session.internal/session");
  return internalJson<StoredSession>(response, "SESSION_REQUIRED");
}

async function deleteSession(env: BrokerEnv, handle: string): Promise<void> {
  await sessionStub(env, handle).fetch("https://session.internal/session", { method: "DELETE" });
}

async function accessToken(
  env: BrokerEnv,
  config: BrokerConfig,
  handle: string,
  session: StoredSession,
): Promise<{ token: string; session: StoredSession }> {
  let tokens: GitHubTokenSet;
  try {
    tokens = await decryptTokenSet(session.encryptedTokens, env.SESSION_ENCRYPTION_KEY, handle);
  } catch {
    await deleteSession(env, handle);
    throw new BrokerProblem(401, "SESSION_EXPIRED", "GitHub authorization has expired");
  }
  if (tokens.expiresAt > Date.now() + refreshWindowMs) {
    return { token: tokens.accessToken, session };
  }
  if (tokens.refreshTokenExpiresAt <= Date.now()) {
    await deleteSession(env, handle);
    throw new BrokerProblem(401, "SESSION_EXPIRED", "GitHub authorization has expired");
  }
  const leaseResponse = await sessionStub(env, handle).fetch(
    "https://session.internal/refresh/acquire",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encryptedTokens: session.encryptedTokens }),
    },
  );
  const leaseResult = (await leaseResponse.json()) as {
    code?: string;
    status?: "acquired" | "updated";
    lease?: string;
    session?: StoredSession;
  };
  if (leaseResponse.status === 409 && leaseResult.code === "REFRESH_IN_PROGRESS") {
    throw new BrokerProblem(503, "BROKER_UNAVAILABLE", "The authentication service is temporarily busy");
  }
  if (!leaseResponse.ok) {
    if (leaseResult.code === "SESSION_REQUIRED") {
      throw new BrokerProblem(401, "SESSION_REQUIRED", "Sign in with GitHub to continue");
    }
    throw new BrokerProblem(503, "BROKER_UNAVAILABLE", "The authentication service is temporarily busy");
  }
  if (leaseResult.status === "updated" && leaseResult.session) {
    return accessToken(env, config, handle, leaseResult.session);
  }
  if (leaseResult.status !== "acquired" || !leaseResult.lease) {
    throw new BrokerProblem(503, "BROKER_UNAVAILABLE", "The authentication service is temporarily busy");
  }
  try {
    const refreshed = await githubClient(env, config).refreshTokens(tokens.refreshToken);
    session.encryptedTokens = await encryptTokenSet(refreshed, env.SESSION_ENCRYPTION_KEY, handle);
    session.idleExpiresAt = Math.min(session.expiresAt, Date.now() + sessionIdleMs);
    const update = await sessionStub(env, handle).fetch("https://session.internal/tokens", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encryptedTokens: session.encryptedTokens,
        idleExpiresAt: session.idleExpiresAt,
        lease: leaseResult.lease,
      }),
    });
    await internalJson(update, "BROKER_UNAVAILABLE");
    return { token: refreshed.accessToken, session };
  } catch (error) {
    const invalid = error instanceof BrokerProblem && error.code === "SESSION_EXPIRED";
    await sessionStub(env, handle).fetch(
      invalid
        ? "https://session.internal/refresh/invalidate"
        : "https://session.internal/refresh/release",
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lease: leaseResult.lease }),
      },
    );
    if (error instanceof BrokerProblem) throw error;
    throw new BrokerProblem(401, "SESSION_EXPIRED", "GitHub authorization has expired");
  }
}

function oauthCookie(config: BrokerConfig): { name: string; secure: boolean } {
  const secure = new URL(config.brokerPublicUrl).protocol === "https:";
  return { name: secure ? "__Host-mmd2pptx_oauth" : "mmd2pptx_oauth", secure };
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function setTransactionCookie(config: BrokerConfig, state: string): string {
  const cookie = oauthCookie(config);
  return `${cookie.name}=${state}; Path=/; HttpOnly; ${cookie.secure ? "Secure; " : ""}SameSite=Lax; Max-Age=300`;
}

function clearTransactionCookie(config: BrokerConfig): string {
  const cookie = oauthCookie(config);
  return `${cookie.name}=; Path=/; HttpOnly; ${cookie.secure ? "Secure; " : ""}SameSite=Lax; Max-Age=0`;
}

function completionHtml(completion: InternalCompletion): string {
  const nonce = randomToken(18);
  const message = JSON.stringify({
    type: "mmd2pptx:github-auth",
    exchangeCode: completion.exchangeCode,
  }).replaceAll("<", "\\u003c");
  const targetOrigin = JSON.stringify(completion.returnOrigin);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GitHub connected</title></head>
<body><p>GitHub authorization complete. You can close this window.</p>
<script nonce="${nonce}">
if (window.opener) {
  window.opener.postMessage(${message}, ${targetOrigin});
  window.close();
}
</script></body></html>`;
}

async function route(request: Request, env: BrokerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ status: "ok" });
  }

  const config = configFromEnv(env);
  const github = githubClient(env, config);

  if (request.method === "OPTIONS") {
    const origin = requestOrigin(request, config);
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      },
    });
  }

  if (
    url.pathname === "/auth/github/start" ||
    url.pathname === "/auth/github/callback" ||
    url.pathname === "/auth/github/complete" ||
    url.pathname === "/auth/session/exchange"
  ) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "local-development";
    await enforceRateLimit(env.AUTH_RATE_LIMITER, ip);
  }

  if (request.method === "GET" && url.pathname === "/auth/github/start") {
    const returnOrigin = url.searchParams.get("return_origin") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (!config.allowedOrigins.has(returnOrigin)) {
      throw new BrokerProblem(400, "RETURN_ORIGIN_NOT_ALLOWED", "Return origin is not allowed");
    }
    if (url.searchParams.get("code_challenge_method") !== "S256" || !isPkceChallenge(challenge)) {
      throw new BrokerProblem(400, "INVALID_PKCE_CHALLENGE", "A valid PKCE S256 challenge is required");
    }
    const state = randomToken();
    const created = await transactionStub(env, state).fetch("https://transaction.internal/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, challenge, returnOrigin }),
    });
    await internalJson(created, "BROKER_UNAVAILABLE");
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "no-store",
        Location: github.authorizationUrl(state, challenge),
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/auth/github/callback") {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/u.test(state) || !code || url.searchParams.has("error")) {
      throw new BrokerProblem(400, "GITHUB_CALLBACK_INVALID", "GitHub authorization was not completed");
    }
    const staged = await transactionStub(env, state).fetch("https://transaction.internal/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    await internalJson(staged, "GITHUB_CALLBACK_INVALID");
    const headers = new Headers({
      "Cache-Control": "no-store",
      Location: `${config.brokerPublicUrl}/auth/github/complete`,
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": setTransactionCookie(config, state),
    });
    return new Response(null, { status: 303, headers });
  }

  if (request.method === "GET" && url.pathname === "/auth/github/complete") {
    const cookie = oauthCookie(config);
    const state = cookieValue(request, cookie.name);
    if (!state || !/^[A-Za-z0-9_-]{43}$/u.test(state)) {
      throw new BrokerProblem(401, "SESSION_EXPIRED", "GitHub authorization has expired");
    }
    const response = await transactionStub(env, state).fetch("https://transaction.internal/complete");
    const completion = await internalJson<InternalCompletion>(response, "BROKER_UNAVAILABLE");
    const html = completionHtml(completion);
    const nonceMatch = /nonce="([^"]+)"/u.exec(html);
    const nonce = nonceMatch?.[1] ?? "";
    return new Response(html, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
        "Content-Type": "text/html; charset=utf-8",
        "Cross-Origin-Opener-Policy": "unsafe-none",
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": clearTransactionCookie(config),
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/auth/session/exchange") {
    const origin = requestOrigin(request, config);
    const input = await smallJson<{ exchangeCode?: unknown; codeVerifier?: unknown }>(request);
    if (typeof input.exchangeCode !== "string" || typeof input.codeVerifier !== "string") {
      throw new BrokerProblem(400, "INVALID_REQUEST", "Exchange code and PKCE verifier are required");
    }
    const state = input.exchangeCode.split(".", 1)[0] ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/u.test(state)) {
      throw new BrokerProblem(400, "INVALID_REQUEST", "Exchange code is invalid");
    }
    const consumed = await transactionStub(env, state).fetch("https://transaction.internal/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        exchangeCode: input.exchangeCode,
        verifier: input.codeVerifier,
        origin,
      }),
    });
    const exchange = await internalJson<InternalExchange>(consumed, "GITHUB_AUTH_FAILED");
    const tokens = await github.exchangeAuthorizationCode(exchange.authorizationCode, input.codeVerifier);
    const actor = await github.getActor(tokens.accessToken);
    const handle = randomToken();
    const now = Date.now();
    const session: StoredSession = {
      encryptedTokens: await encryptTokenSet(tokens, env.SESSION_ENCRYPTION_KEY, handle),
      actor,
      createdAt: now,
      expiresAt: now + sessionLifetimeMs,
      idleExpiresAt: now + sessionIdleMs,
    };
    const created = await sessionStub(env, handle).fetch("https://session.internal/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session),
    });
    await internalJson(created, "BROKER_UNAVAILABLE");
    return jsonResponse(
      {
        session_handle: handle,
        session: {
          signed_in: true,
          actor,
          expires_at: new Date(session.expiresAt).toISOString(),
          install_url: `https://github.com/apps/${config.githubAppSlug}/installations/new`,
        },
      },
      origin,
      201,
    );
  }

  if (request.method === "GET" && url.pathname === "/api/github/session") {
    const origin = requestOrigin(request, config);
    const handle = parseBearer(request);
    await enforceSessionRateLimit(env, handle);
    const session = await loadSession(env, handle);
    return jsonResponse(
      {
        signed_in: true,
        actor: session.actor,
        expires_at: new Date(session.expiresAt).toISOString(),
        install_url: `https://github.com/apps/${config.githubAppSlug}/installations/new`,
      },
      origin,
    );
  }

  if (request.method === "GET" && url.pathname === "/api/github/installations") {
    const origin = requestOrigin(request, config);
    const handle = parseBearer(request);
    await enforceSessionRateLimit(env, handle);
    const session = await loadSession(env, handle);
    const cursor = url.searchParams.get("cursor");
    let page: CollectionPage<InstallationItem>;
    if (cursor) {
      const response = await sessionStub(env, handle).fetch(
        "https://session.internal/installations/page",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cursor }),
        },
      );
      page = await internalJson(response, "BROKER_UNAVAILABLE");
    } else {
      const authorized = await accessToken(env, config, handle, session);
      let installations: InstallationItem[];
      try {
        installations = await github.listInstallations(authorized.token);
      } catch (error) {
        if (error instanceof BrokerProblem && error.code === "SESSION_EXPIRED") {
          await deleteSession(env, handle);
        }
        throw error;
      }
      const response = await sessionStub(env, handle).fetch(
        "https://session.internal/installations/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: installations }),
        },
      );
      page = await internalJson(response, "BROKER_UNAVAILABLE");
    }
    return jsonResponse(page, origin);
  }

  if (request.method === "POST" && url.pathname === "/auth/logout") {
    const origin = requestOrigin(request, config);
    const handle = parseBearer(request);
    await enforceSessionRateLimit(env, handle);
    await deleteSession(env, handle);
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Cache-Control": "no-store",
        Vary: "Origin",
      },
    });
  }

  throw new BrokerProblem(404, "NOT_FOUND", "Route not found");
}

export default {
  async fetch(request: Request, env: BrokerEnv): Promise<Response> {
    const requestId = randomToken(12);
    let origin: string | undefined;
    try {
      const candidate = request.headers.get("Origin");
      if (candidate && env.ALLOWED_ORIGINS?.split(",").map((value) => value.trim()).includes(candidate)) {
        origin = candidate;
      }
      return await route(request, env);
    } catch (error) {
      if (error instanceof BrokerProblem) return problemResponse(error, requestId, origin);
      return problemResponse(
        new BrokerProblem(500, "BROKER_UNAVAILABLE", "The authentication service is unavailable"),
        requestId,
        origin,
      );
    }
  },
} satisfies ExportedHandler<BrokerEnv>;
