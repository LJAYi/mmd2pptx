import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredSession } from "../src/contracts";
import { sha256Base64Url } from "../src/crypto";
import { GitHubClient } from "../src/github";
import { MockFetchRouter } from "./mock-fetch";

const origin = "https://app.test";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
let outbound: MockFetchRouter;
const broker = exports.default;

beforeEach(() => {
  outbound = new MockFetchRouter();
});

afterEach(() => {
  try {
    outbound.assertDone();
  } finally {
    vi.restoreAllMocks();
  }
});

async function beginAuthorization(): Promise<{ state: string; challenge: string }> {
  const challenge = await sha256Base64Url(verifier);
  const response = await broker.fetch(
    `https://broker.test/auth/github/start?return_origin=${encodeURIComponent(origin)}&code_challenge=${challenge}&code_challenge_method=S256`,
    { redirect: "manual" },
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location") ?? "");
  expect(location.origin).toBe("https://github.test");
  expect(location.pathname).toBe("/login/oauth/authorize");
  expect(location.searchParams.get("code_challenge")).toBe(challenge);
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  const state = location.searchParams.get("state");
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  return { state: state ?? "", challenge };
}

async function stageAndComplete(state: string): Promise<string> {
  const callback = await broker.fetch(
    `https://broker.test/auth/github/callback?code=github-authorization-code&state=${state}`,
    { redirect: "manual" },
  );
  expect(callback.status).toBe(303);
  expect(callback.headers.get("Location")).toBe("https://broker.test/auth/github/complete");
  expect(callback.headers.get("Location")).not.toContain("code=");
  const setCookie = callback.headers.get("Set-Cookie") ?? "";
  expect(setCookie).toContain("__Host-mmd2pptx_oauth=");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");

  const complete = await broker.fetch("https://broker.test/auth/github/complete", {
    headers: { Cookie: setCookie.split(";", 1)[0] ?? "" },
  });
  expect(complete.status).toBe(200);
  expect(complete.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  expect(complete.headers.get("Set-Cookie")).toContain("Max-Age=0");
  const html = await complete.text();
  expect(html).not.toContain("github-authorization-code");
  const exchangeCode = /"exchangeCode":"([A-Za-z0-9_.-]+)"/u.exec(html)?.[1];
  expect(exchangeCode).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u);
  return exchangeCode ?? "";
}

function mockTokenAndActor(): void {
  outbound.json("POST", "https://github.test/login/oauth/access_token", 200, {
    access_token: "github-user-access-token",
    expires_in: 28_800,
    refresh_token: "github-user-refresh-token",
    refresh_token_expires_in: 15_897_600,
    token_type: "bearer",
    scope: "",
  });
  outbound.json("GET", "https://api.github.test/user", 200, {
    id: 42,
    login: "octocat",
    avatar_url: "https://avatars.test/42",
  });
}

async function exchangeSession(exchangeCode: string): Promise<string> {
  mockTokenAndActor();
  const response = await broker.fetch("https://broker.test/auth/session/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ exchangeCode, codeVerifier: verifier }),
  });
  expect(response.status).toBe(201);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  const value = (await response.json()) as {
    session_handle: string;
    session: { actor: { login: string }; install_url: string };
  };
  expect(value.session_handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(value.session.actor.login).toBe("octocat");
  expect(value.session.install_url).toBe(
    "https://github.com/apps/mmd2pptx-test/installations/new",
  );
  expect(JSON.stringify(value)).not.toContain("github-user-access-token");
  return value.session_handle;
}

describe("GitHub authentication shell", () => {
  it("completes PKCE authorization, keeps GitHub tokens encrypted, and signs out", async () => {
    const { state } = await beginAuthorization();
    const exchangeCode = await stageAndComplete(state);
    const handle = await exchangeSession(exchangeCode);

    const sessionResponse = await broker.fetch("https://broker.test/api/github/session", {
      headers: { Authorization: `Bearer ${handle}`, Origin: origin },
    });
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toMatchObject({
      signed_in: true,
      actor: { id: 42, login: "octocat" },
    });

    const stub = env.AUTH_SESSIONS.get(env.AUTH_SESSIONS.idFromName(handle));
    const stored = await runInDurableObject(stub, async (_instance, stateStorage) =>
      stateStorage.storage.get<StoredSession>("session"),
    );
    expect(stored?.encryptedTokens).toMatch(/^v1\./u);
    expect(stored?.encryptedTokens).not.toContain("github-user-access-token");
    expect(stored?.encryptedTokens).not.toContain("github-user-refresh-token");

    const logout = await broker.fetch("https://broker.test/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${handle}`, Origin: origin },
    });
    expect(logout.status).toBe(204);

    const afterLogout = await broker.fetch("https://broker.test/api/github/session", {
      headers: { Authorization: `Bearer ${handle}`, Origin: origin },
    });
    expect(afterLogout.status).toBe(401);
    expect(await afterLogout.json()).toMatchObject({ code: "SESSION_REQUIRED" });
  });

  it("rejects a PKCE mismatch without consuming the valid exchange", async () => {
    const { state } = await beginAuthorization();
    const exchangeCode = await stageAndComplete(state);
    const mismatch = await broker.fetch("https://broker.test/auth/session/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        exchangeCode,
        codeVerifier: "z".repeat(43),
      }),
    });
    expect(mismatch.status).toBe(401);
    expect(await mismatch.json()).toMatchObject({ code: "PKCE_MISMATCH" });

    const handle = await exchangeSession(exchangeCode);
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const replay = await broker.fetch("https://broker.test/auth/session/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ exchangeCode, codeVerifier: verifier }),
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ code: "TRANSACTION_REPLAYED" });
  });

  it("enforces exact origins and PKCE challenge shape before redirecting", async () => {
    const challenge = await sha256Base64Url(verifier);
    const disallowed = await broker.fetch(
      `https://broker.test/auth/github/start?return_origin=https%3A%2F%2Fevil.test&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    expect(disallowed.status).toBe(400);
    expect(await disallowed.json()).toMatchObject({ code: "RETURN_ORIGIN_NOT_ALLOWED" });

    const invalidPkce = await broker.fetch(
      `https://broker.test/auth/github/start?return_origin=${encodeURIComponent(origin)}&code_challenge=short&code_challenge_method=plain`,
      { redirect: "manual" },
    );
    expect(invalidPkce.status).toBe(400);
    expect(await invalidPkce.json()).toMatchObject({ code: "INVALID_PKCE_CHALLENGE" });

    const preflight = await broker.fetch("https://broker.test/api/github/session", {
      method: "OPTIONS",
      headers: { Origin: origin },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("reports non-expiring user tokens as a GitHub App configuration error", async () => {
    const { state } = await beginAuthorization();
    const exchangeCode = await stageAndComplete(state);
    outbound.json("POST", "https://github.test/login/oauth/access_token", 200, {
      access_token: "non-expiring-access-token",
      token_type: "bearer",
      scope: "",
    });

    const response = await broker.fetch("https://broker.test/auth/session/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ exchangeCode, codeVerifier: verifier }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "BROKER_MISCONFIGURED" });
  });

  it("distinguishes invalid GitHub App credentials from an expired authorization", async () => {
    const { state } = await beginAuthorization();
    const exchangeCode = await stageAndComplete(state);
    outbound.json("POST", "https://github.test/login/oauth/access_token", 200, {
      error: "invalid_client",
    });

    const response = await broker.fetch("https://broker.test/auth/session/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ exchangeCode, codeVerifier: verifier }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "BROKER_MISCONFIGURED" });
  });

  it("rejects unsafe GitHub base URL path prefixes", () => {
    expect(
      () => new GitHubClient({
        apiBaseUrl: "https://api.github.test/v3",
        oauthBaseUrl: "https://github.test",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        brokerPublicUrl: "https://broker.test",
      }),
    ).toThrow("GITHUB_API_BASE_URL is not a safe base URL");
  });
});
