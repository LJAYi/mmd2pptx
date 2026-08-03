import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Base64Url } from "../src/crypto";
import { MockFetchRouter } from "./mock-fetch";

const origin = "https://app.test";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
let outbound: MockFetchRouter;
const broker = exports.default;

beforeEach(() => {
  outbound = new MockFetchRouter();
});

afterEach(() => {
  outbound.assertDone();
  vi.restoreAllMocks();
});

async function authenticatedHandle(expiresIn = 28_800): Promise<string> {
  const challenge = await sha256Base64Url(verifier);
  const start = await broker.fetch(
    `https://broker.test/auth/github/start?return_origin=${encodeURIComponent(origin)}&code_challenge=${challenge}&code_challenge_method=S256`,
    { redirect: "manual" },
  );
  const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state") ?? "";
  const callback = await broker.fetch(
    `https://broker.test/auth/github/callback?code=installations-code&state=${state}`,
    { redirect: "manual" },
  );
  const complete = await broker.fetch("https://broker.test/auth/github/complete", {
    headers: { Cookie: (callback.headers.get("Set-Cookie") ?? "").split(";", 1)[0] ?? "" },
  });
  const exchangeCode = /"exchangeCode":"([A-Za-z0-9_.-]+)"/u.exec(await complete.text())?.[1] ?? "";

  outbound.json("POST", "https://github.test/login/oauth/access_token", 200, {
    access_token: "installation-access-token",
    expires_in: expiresIn,
    refresh_token: "installation-refresh-token",
    refresh_token_expires_in: 15_897_600,
    token_type: "bearer",
    scope: "",
  });
  outbound.json("GET", "https://api.github.test/user", 200, {
    id: 9,
    login: "diagrammer",
    avatar_url: "https://avatars.test/9",
  });

  const exchanged = await broker.fetch("https://broker.test/auth/session/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ exchangeCode, codeVerifier: verifier }),
  });
  const value = (await exchanged.json()) as { session_handle: string };
  return value.session_handle;
}

describe("installation listing", () => {
  it("sorts, minimizes, snapshots, and paginates accessible installations", async () => {
    const handle = await authenticatedHandle();
    const installations = Array.from({ length: 55 }, (_, index) => ({
      id: 1_000 - index,
      account: {
        id: 2_000 + index,
        login: `team-${String(54 - index).padStart(2, "0")}`,
        avatar_url: `https://avatars.test/team-${index}`,
        type: "Organization",
      },
      repository_selection: "selected",
      suspended_at: null,
      permissions: { contents: "read" },
      access_tokens_url: "must-not-be-returned",
    }));
    outbound.json(
      "GET",
      "https://api.github.test/user/installations?per_page=100&page=1",
      200,
      { total_count: installations.length, installations },
    );

    const first = await broker.fetch("https://broker.test/api/github/installations", {
      headers: { Authorization: `Bearer ${handle}`, Origin: origin },
    });
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as {
      items: Array<{ id: number; account: { login: string } }>;
      next_cursor: string;
      has_more: boolean;
    };
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.items[0]?.account.login).toBe("team-00");
    expect(firstPage.items[49]?.account.login).toBe("team-49");
    expect(firstPage.has_more).toBe(true);
    expect(firstPage.next_cursor).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(firstPage)).not.toContain("permissions");
    expect(JSON.stringify(firstPage)).not.toContain("access_tokens_url");

    const pageUrl =
      `https://broker.test/api/github/installations?cursor=${firstPage.next_cursor}`;
    const concurrent = await Promise.all([
      broker.fetch(pageUrl, { headers: { Authorization: `Bearer ${handle}`, Origin: origin } }),
      broker.fetch(pageUrl, { headers: { Authorization: `Bearer ${handle}`, Origin: origin } }),
    ]);
    const second = concurrent.find((response) => response.status === 200);
    const rejectedReplay = concurrent.find((response) => response.status === 400);
    expect(second).toBeDefined();
    expect(rejectedReplay).toBeDefined();
    expect(await rejectedReplay?.json()).toMatchObject({ code: "INVALID_CURSOR" });
    if (!second) throw new Error("Expected one successful cursor consumer");
    const secondPage = (await second.json()) as {
      items: Array<{ account: { login: string } }>;
      next_cursor: null;
      has_more: boolean;
    };
    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.items[0]?.account.login).toBe("team-50");
    expect(secondPage.next_cursor).toBeNull();
    expect(secondPage.has_more).toBe(false);

    const replay = await broker.fetch(
      pageUrl,
      { headers: { Authorization: `Bearer ${handle}`, Origin: origin } },
    );
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("rotates an expiring GitHub token before listing installations", async () => {
    const handle = await authenticatedHandle(60);
    outbound.json("POST", "https://github.test/login/oauth/access_token", 200, {
      access_token: "refreshed-installation-access-token",
      expires_in: 28_800,
      refresh_token: "rotated-installation-refresh-token",
      refresh_token_expires_in: 15_897_600,
      token_type: "bearer",
      scope: "",
    });
    outbound.json(
      "GET",
      "https://api.github.test/user/installations?per_page=100&page=1",
      200,
      { total_count: 0, installations: [] },
      { Authorization: "Bearer refreshed-installation-access-token" },
    );

    const response = await broker.fetch("https://broker.test/api/github/installations", {
      headers: { Authorization: `Bearer ${handle}`, Origin: origin },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], next_cursor: null, has_more: false });

    const session = await broker.fetch("https://broker.test/api/github/session", {
      headers: { Authorization: `Bearer ${handle}`, Origin: origin },
    });
    expect(session.status).toBe(200);
  });

  it("invalidates the app session when GitHub rejects token refresh", async () => {
    const handle = await authenticatedHandle(60);
    outbound.json("POST", "https://github.test/login/oauth/access_token", 401, {
      error: "bad_refresh_token",
    });

    const response = await broker.fetch("https://broker.test/api/github/installations", {
      headers: { Authorization: `Bearer ${handle}`, Origin: origin },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "SESSION_EXPIRED" });

    const session = await broker.fetch("https://broker.test/api/github/session", {
      headers: { Authorization: `Bearer ${handle}`, Origin: origin },
    });
    expect(session.status).toBe(401);
    expect(await session.json()).toMatchObject({ code: "SESSION_REQUIRED" });
  });
});
