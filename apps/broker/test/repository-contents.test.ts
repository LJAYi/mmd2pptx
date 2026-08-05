import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Base64Url } from "../src/crypto";
import { maxSourceBytes } from "../src/github";
import { MockFetchRouter } from "./mock-fetch";

const origin = "https://app.test";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const installationId = 77;
const repositoryId = 88;
const broker = exports.default;
let outbound: MockFetchRouter;

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

async function authenticatedHandle(): Promise<string> {
  const challenge = await sha256Base64Url(verifier);
  const start = await broker.fetch(
    `https://broker.test/auth/github/start?return_origin=${encodeURIComponent(origin)}&code_challenge=${challenge}&code_challenge_method=S256`,
    { redirect: "manual" },
  );
  const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state") ?? "";
  const callback = await broker.fetch(
    `https://broker.test/auth/github/callback?code=repository-code&state=${state}`,
    { redirect: "manual" },
  );
  const complete = await broker.fetch("https://broker.test/auth/github/complete", {
    headers: { Cookie: (callback.headers.get("Set-Cookie") ?? "").split(";", 1)[0] ?? "" },
  });
  const exchangeCode = /"exchangeCode":"([A-Za-z0-9_.-]+)"/u.exec(await complete.text())?.[1] ?? "";
  outbound.json("POST", "https://github.test/login/oauth/access_token", 200, {
    access_token: "repository-access-token",
    expires_in: 28_800,
    refresh_token: "repository-refresh-token",
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
  return ((await exchanged.json()) as { session_handle: string }).session_handle;
}

function repository(id = repositoryId, fullName = "diagrammer/docs") {
  const [login, name] = fullName.split("/") as [string, string];
  return {
    id,
    name,
    full_name: fullName,
    owner: { login, avatar_url: `https://avatars.test/${login}` },
    private: true,
    default_branch: "main",
    permissions: { admin: true },
    clone_url: "must-not-be-returned",
  };
}

function mockRepositories(repositories = [repository()]): void {
  outbound.json(
    "GET",
    `https://api.github.test/user/installations/${installationId}/repositories?per_page=100&page=1`,
    200,
    { total_count: repositories.length, repositories },
  );
}

function mockCommit(treeSha = "tree-root"): void {
  outbound.json(
    "GET",
    "https://api.github.test/repos/diagrammer/docs/git/ref/heads/main",
    200,
    { ref: "refs/heads/main", object: { type: "commit", sha: "commit-main" } },
  );
  outbound.json(
    "GET",
    "https://api.github.test/repos/diagrammer/docs/git/commits/commit-main",
    200,
    { sha: "commit-main", tree: { sha: treeSha } },
  );
}

function request(handle: string, path = ""): Promise<Response> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return broker.fetch(
    `https://broker.test/api/github/installations/${installationId}/repositories/${repositoryId}/contents${query}`,
    { headers: { Authorization: `Bearer ${handle}`, Origin: origin } },
  );
}

describe("repository and source browsing", () => {
  it("minimizes, sorts, snapshots, and paginates installation repositories", async () => {
    const handle = await authenticatedHandle();
    const repositories = Array.from({ length: 55 }, (_, index) =>
      repository(100 + index, `team/repo-${String(54 - index).padStart(2, "0")}`),
    );
    mockRepositories(repositories);
    const first = await broker.fetch(
      `https://broker.test/api/github/installations/${installationId}/repositories`,
      { headers: { Authorization: `Bearer ${handle}`, Origin: origin } },
    );
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as {
      items: Array<{ fullName: string; installationId: number }>;
      next_cursor: string;
      has_more: boolean;
    };
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.items[0]).toMatchObject({
      fullName: "team/repo-00",
      installationId,
    });
    expect(firstPage.has_more).toBe(true);
    expect(JSON.stringify(firstPage)).not.toContain("clone_url");
    expect(JSON.stringify(firstPage)).not.toContain("permissions");

    mockRepositories(repositories);
    const second = await broker.fetch(
      `https://broker.test/api/github/installations/${installationId}/repositories?cursor=${firstPage.next_cursor}`,
      { headers: { Authorization: `Bearer ${handle}`, Origin: origin } },
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ has_more: false, next_cursor: null });
  });

  it("lists immediate children and marks only safe supported sources as openable", async () => {
    const handle = await authenticatedHandle();
    mockRepositories();
    mockCommit();
    outbound.json(
      "GET",
      "https://api.github.test/repos/diagrammer/docs/git/trees/tree-root",
      200,
      {
        sha: "tree-root",
        truncated: false,
        tree: [
          { path: "z.txt", mode: "100644", type: "blob", sha: "blob-z", size: 10 },
          { path: "diagrams", mode: "040000", type: "tree", sha: "tree-diagrams" },
          { path: "README.MD", mode: "100644", type: "blob", sha: "blob-readme", size: 12 },
          { path: "large.mmd", mode: "100644", type: "blob", sha: "blob-large", size: maxSourceBytes + 1 },
          { path: "linked.mmd", mode: "120000", type: "blob", sha: "blob-link", size: 8 },
        ],
      },
    );

    const response = await request(handle);
    expect(response.status).toBe(200);
    const value = (await response.json()) as { kind: string; items: Array<Record<string, unknown>> };
    expect(value.kind).toBe("directory");
    expect(value.items).toEqual([
      expect.objectContaining({ name: "diagrams", type: "directory", supported: true }),
      expect.objectContaining({ name: "large.mmd", type: "file", supported: false }),
      expect.objectContaining({ name: "linked.mmd", type: "file", supported: false }),
      expect.objectContaining({ name: "README.MD", type: "file", supported: true }),
      expect.objectContaining({ name: "z.txt", type: "file", supported: false }),
    ]);
  });

  it("walks trees without following links and returns an exact UTF-8 Markdown blob", async () => {
    const handle = await authenticatedHandle();
    const source = "# Architecture 🧩\n\nCafé\n\n```mermaid\nflowchart LR\n  A --> B\n```\n";
    const bytes = new TextEncoder().encode(source);
    mockRepositories();
    mockCommit();
    outbound.json(
      "GET",
      "https://api.github.test/repos/diagrammer/docs/git/trees/tree-root",
      200,
      {
        sha: "tree-root",
        truncated: false,
        tree: [{ path: "diagrams", mode: "040000", type: "tree", sha: "tree-diagrams" }],
      },
    );
    outbound.json(
      "GET",
      "https://api.github.test/repos/diagrammer/docs/git/trees/tree-diagrams",
      200,
      {
        sha: "tree-diagrams",
        truncated: false,
        tree: [{ path: "system.md", mode: "100644", type: "blob", sha: "blob-system", size: bytes.length }],
      },
    );
    outbound.json(
      "GET",
      "https://api.github.test/repos/diagrammer/docs/git/blobs/blob-system",
      200,
      {
        sha: "blob-system",
        encoding: "base64",
        size: bytes.length,
        content: btoa(String.fromCharCode(...bytes)),
      },
    );

    const response = await request(handle, "diagrams/system.md");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "file",
      repositoryId,
      path: "diagrams/system.md",
      ref: "main",
      commitSha: "commit-main",
      blobSha: "blob-system",
      size: bytes.length,
      source,
    });
  });

  it("paginates a directory snapshot and binds its cursor to the requested path", async () => {
    const handle = await authenticatedHandle();
    mockRepositories();
    mockCommit();
    outbound.json(
      "GET",
      "https://api.github.test/repos/diagrammer/docs/git/trees/tree-root",
      200,
      {
        sha: "tree-root",
        truncated: false,
        tree: Array.from({ length: 51 }, (_, index) => ({
          path: `diagram-${String(index).padStart(2, "0")}.mmd`,
          mode: "100644",
          type: "blob",
          sha: `blob-${index}`,
          size: 10,
        })),
      },
    );
    const first = await request(handle);
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as {
      kind: string;
      commitSha: string;
      items: unknown[];
      next_cursor: string;
      has_more: boolean;
    };
    expect(firstPage).toMatchObject({
      kind: "directory",
      commitSha: "commit-main",
      has_more: true,
    });
    expect(firstPage.items).toHaveLength(50);

    mockRepositories();
    const conflicting = await broker.fetch(
      `https://broker.test/api/github/installations/${installationId}/repositories/${repositoryId}/contents?path=other&cursor=${firstPage.next_cursor}`,
      { headers: { Authorization: `Bearer ${handle}`, Origin: origin } },
    );
    expect(conflicting.status).toBe(400);
    expect(await conflicting.json()).toMatchObject({ code: "INVALID_CURSOR" });

    mockRepositories();
    const second = await broker.fetch(
      `https://broker.test/api/github/installations/${installationId}/repositories/${repositoryId}/contents?cursor=${firstPage.next_cursor}`,
      { headers: { Authorization: `Bearer ${handle}`, Origin: origin } },
    );
    expect(second.status).toBe(200);
    const secondPage = (await second.json()) as { items: unknown[] };
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage).toMatchObject({
      kind: "directory",
      commitSha: "commit-main",
      next_cursor: null,
      has_more: false,
    });
  });

  it("rejects traversal paths before contacting GitHub", async () => {
    const handle = await authenticatedHandle();
    const response = await request(handle, "../private.mmd");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_PATH" });
  });

  it("classifies GitHub secondary throttling as rate limited before permission errors", async () => {
    const handle = await authenticatedHandle();
    outbound.json(
      "GET",
      `https://api.github.test/user/installations/${installationId}/repositories?per_page=100&page=1`,
      403,
      { message: "secondary rate limit" },
      undefined,
      { "Retry-After": "60" },
    );

    const response = await broker.fetch(
      `https://broker.test/api/github/installations/${installationId}/repositories`,
      { headers: { Authorization: `Bearer ${handle}`, Origin: origin } },
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "GITHUB_RATE_LIMITED" });
  });

  it("does not fetch oversized source blobs", async () => {
    const handle = await authenticatedHandle();
    mockRepositories();
    mockCommit();
    outbound.json(
      "GET",
      "https://api.github.test/repos/diagrammer/docs/git/trees/tree-root",
      200,
      {
        sha: "tree-root",
        truncated: false,
        tree: [{ path: "large.mmd", mode: "100644", type: "blob", sha: "blob-large", size: maxSourceBytes + 1 }],
      },
    );
    const response = await request(handle, "large.mmd");
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});
