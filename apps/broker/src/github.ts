import type {
  DirectoryItem,
  GitHubActor,
  GitHubTokenSet,
  InstallationItem,
  RepositoryItem,
  SourceFile,
} from "./contracts";
import { BrokerProblem } from "./problem";

interface GitHubTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
  error?: unknown;
}

interface GitHubClientConfig {
  apiBaseUrl: string;
  oauthBaseUrl: string;
  clientId: string;
  clientSecret: string;
  brokerPublicUrl: string;
}

const githubHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "mmd2pptx-github-broker",
  "X-GitHub-Api-Version": "2022-11-28",
};
const maxGitHubJsonBytes = 2 * 1024 * 1024;
const githubRequestTimeoutMs = 10_000;
const maxCollectionItems = 5_000;
export const maxSourceBytes = 256 * 1024;
const supportedExtensions = [".mmd", ".mermaid", ".md"];

interface GitHubErrorOptions {
  notFoundCode?: string;
  forbiddenCode?: string;
}

export interface ResolvedDirectory {
  kind: "directory";
  repositoryId: number;
  path: string;
  ref: string;
  commitSha: string;
  items: DirectoryItem[];
}

function fixedBaseUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrokerProblem(500, "BROKER_MISCONFIGURED", `${label} is not a valid URL`);
  }
  if (
    !/^https?:$/u.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new BrokerProblem(500, "BROKER_MISCONFIGURED", `${label} is not a safe base URL`);
  }
  return url;
}

function tokenSetFromResponse(value: GitHubTokenResponse, now: number): GitHubTokenSet {
  if (
    typeof value.access_token === "string" &&
    value.refresh_token === undefined &&
    value.refresh_token_expires_in === undefined
  ) {
    throw new BrokerProblem(
      500,
      "BROKER_MISCONFIGURED",
      "GitHub App user access token expiration must be enabled",
    );
  }
  if (
    typeof value.access_token !== "string" ||
    typeof value.expires_in !== "number" ||
    typeof value.refresh_token !== "string" ||
    typeof value.refresh_token_expires_in !== "number" ||
    typeof value.token_type !== "string" ||
    typeof value.scope !== "string"
  ) {
    throw new BrokerProblem(502, "GITHUB_AUTH_FAILED", "GitHub returned an invalid token response");
  }
  return {
    accessToken: value.access_token,
    expiresAt: now + value.expires_in * 1000,
    refreshToken: value.refresh_token,
    refreshTokenExpiresAt: now + value.refresh_token_expires_in * 1000,
    tokenType: value.token_type,
    scope: value.scope,
  };
}

async function githubFetch(url: URL, init: RequestInit, code: string): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(githubRequestTimeoutMs),
    });
  } catch {
    throw new BrokerProblem(502, code, "GitHub is temporarily unavailable");
  }
}

async function boundedResponseText(response: Response, code: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxGitHubJsonBytes) {
      try {
        await reader.cancel();
      } catch {
        // The size violation is the useful error even if stream cancellation fails.
      }
      throw new BrokerProblem(502, code, "GitHub returned an oversized response");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

async function parseJsonResponse<T>(
  response: Response,
  code: string,
  options: GitHubErrorOptions = {},
): Promise<T> {
  if (!response.ok) {
    if (
      response.status === 429 ||
      (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0")
    ) {
      throw new BrokerProblem(429, "GITHUB_RATE_LIMITED", "GitHub rate limit exceeded");
    }
    if (response.status === 404 && options.notFoundCode) {
      throw new BrokerProblem(404, options.notFoundCode, "The requested GitHub resource was not found");
    }
    if (response.status === 403 && options.forbiddenCode) {
      throw new BrokerProblem(403, options.forbiddenCode, "The GitHub resource is not accessible");
    }
    if (response.status === 401 || response.status === 403) {
      throw new BrokerProblem(401, "SESSION_EXPIRED", "GitHub authorization has expired");
    }
    throw new BrokerProblem(502, code, "GitHub is temporarily unavailable");
  }
  const contentLength = Number(response.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxGitHubJsonBytes) {
    throw new BrokerProblem(502, code, "GitHub returned an oversized response");
  }
  try {
    const text = await boundedResponseText(response, code);
    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof BrokerProblem) throw error;
    throw new BrokerProblem(502, code, "GitHub returned an invalid response");
  }
}

export class GitHubClient {
  private readonly apiBase: URL;
  private readonly oauthBase: URL;
  private readonly redirectUri: string;

  constructor(private readonly config: GitHubClientConfig) {
    this.apiBase = fixedBaseUrl(config.apiBaseUrl, "GITHUB_API_BASE_URL");
    this.oauthBase = fixedBaseUrl(config.oauthBaseUrl, "GITHUB_OAUTH_BASE_URL");
    this.redirectUri = new URL(
      "/auth/github/callback",
      fixedBaseUrl(config.brokerPublicUrl, "BROKER_PUBLIC_URL"),
    ).toString();
  }

  authorizationUrl(state: string, challenge: string): string {
    const url = new URL("/login/oauth/authorize", this.oauthBase);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string, verifier: string): Promise<GitHubTokenSet> {
    return this.exchangeToken({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: this.redirectUri,
    });
  }

  async refreshTokens(refreshToken: string): Promise<GitHubTokenSet> {
    return this.exchangeToken({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  private async exchangeToken(payload: Record<string, string>): Promise<GitHubTokenSet> {
    const url = new URL("/login/oauth/access_token", this.oauthBase);
    const response = await githubFetch(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": githubHeaders["User-Agent"],
        },
        body: JSON.stringify(payload),
      },
      "GITHUB_AUTH_FAILED",
    );
    const value = await parseJsonResponse<GitHubTokenResponse>(response, "GITHUB_AUTH_FAILED");
    if (value.error === "invalid_client" || value.error === "incorrect_client_credentials") {
      throw new BrokerProblem(500, "BROKER_MISCONFIGURED", "GitHub App credentials are invalid");
    }
    if (value.error === "invalid_grant" || value.error === "bad_verification_code") {
      throw new BrokerProblem(401, "SESSION_EXPIRED", "GitHub authorization has expired");
    }
    if (typeof value.error === "string") {
      throw new BrokerProblem(502, "GITHUB_AUTH_FAILED", "GitHub authorization failed");
    }
    return tokenSetFromResponse(value, Date.now());
  }

  async getActor(accessToken: string): Promise<GitHubActor> {
    const url = new URL("/user", this.apiBase);
    const response = await githubFetch(
      url,
      { headers: { ...githubHeaders, Authorization: `Bearer ${accessToken}` } },
      "GITHUB_UNAVAILABLE",
    );
    const value = await parseJsonResponse<Record<string, unknown>>(response, "GITHUB_UNAVAILABLE");
    if (
      typeof value.id !== "number" ||
      typeof value.login !== "string" ||
      typeof value.avatar_url !== "string"
    ) {
      throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned an invalid user response");
    }
    return { id: value.id, login: value.login, avatarUrl: value.avatar_url };
  }

  async listInstallations(accessToken: string): Promise<InstallationItem[]> {
    const items: InstallationItem[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const url = new URL("/user/installations", this.apiBase);
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const response = await githubFetch(
        url,
        { headers: { ...githubHeaders, Authorization: `Bearer ${accessToken}` } },
        "GITHUB_UNAVAILABLE",
      );
      const value = await parseJsonResponse<Record<string, unknown>>(response, "GITHUB_UNAVAILABLE");
      if (!Array.isArray(value.installations)) {
        throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned invalid installations");
      }
      for (const raw of value.installations) {
        const parsed = parseInstallation(raw);
        if (!parsed) {
          throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned invalid installations");
        }
        items.push(parsed);
      }
      if (!hasNextPage(response.headers.get("Link"))) break;
      if (page === 50) {
        throw new BrokerProblem(422, "COLLECTION_TOO_LARGE", "Installation collection is too large");
      }
    }
    return items.sort(
      (left, right) =>
        left.account.login.localeCompare(right.account.login, "en", { sensitivity: "base" }) ||
        left.id - right.id,
    );
  }

  async listInstallationRepositories(
    accessToken: string,
    installationId: number,
  ): Promise<RepositoryItem[]> {
    const items: RepositoryItem[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const url = new URL(`/user/installations/${installationId}/repositories`, this.apiBase);
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const response = await githubFetch(
        url,
        { headers: { ...githubHeaders, Authorization: `Bearer ${accessToken}` } },
        "GITHUB_UNAVAILABLE",
      );
      const value = await parseJsonResponse<Record<string, unknown>>(
        response,
        "GITHUB_UNAVAILABLE",
        {
          notFoundCode: "INSTALLATION_NOT_ACCESSIBLE",
          forbiddenCode: "INSTALLATION_NOT_ACCESSIBLE",
        },
      );
      if (!Array.isArray(value.repositories)) {
        throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned invalid repositories");
      }
      for (const raw of value.repositories) {
        const parsed = parseRepository(raw, installationId);
        if (!parsed) {
          throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned invalid repositories");
        }
        items.push(parsed);
        if (items.length > maxCollectionItems) {
          throw new BrokerProblem(422, "COLLECTION_TOO_LARGE", "Repository collection is too large");
        }
      }
      if (!hasNextPage(response.headers.get("Link"))) break;
      if (page === 50) {
        throw new BrokerProblem(422, "COLLECTION_TOO_LARGE", "Repository collection is too large");
      }
    }
    return items.sort(
      (left, right) =>
        left.fullName.localeCompare(right.fullName, "en", { sensitivity: "base" }) ||
        left.id - right.id,
    );
  }

  async getContents(
    accessToken: string,
    repository: RepositoryItem,
    path: string,
  ): Promise<ResolvedDirectory | SourceFile> {
    const [owner, name] = repository.fullName.split("/", 2);
    if (!owner || !name) {
      throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned an invalid repository name");
    }
    const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const encodedBranch = repository.defaultBranch.split("/").map(encodeURIComponent).join("/");
    const refUrl = new URL(
      `${prefix}/git/ref/heads/${encodedBranch}`,
      this.apiBase,
    );
    const refResponse = await githubFetch(
      refUrl,
      { headers: { ...githubHeaders, Authorization: `Bearer ${accessToken}` } },
      "GITHUB_UNAVAILABLE",
    );
    const ref = await parseJsonResponse<Record<string, unknown>>(
      refResponse,
      "GITHUB_UNAVAILABLE",
      {
        notFoundCode: "CONTENT_NOT_FOUND",
        forbiddenCode: "REPOSITORY_NOT_ACCESSIBLE",
      },
    );
    const refObject = record(ref.object);
    if (refObject?.type !== "commit" || typeof refObject.sha !== "string") {
      throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned an invalid branch ref");
    }
    const commitSha = refObject.sha;
    const commitUrl = new URL(`${prefix}/git/commits/${encodeURIComponent(commitSha)}`, this.apiBase);
    const commitResponse = await githubFetch(
      commitUrl,
      { headers: { ...githubHeaders, Authorization: `Bearer ${accessToken}` } },
      "GITHUB_UNAVAILABLE",
    );
    const commit = await parseJsonResponse<Record<string, unknown>>(
      commitResponse,
      "GITHUB_UNAVAILABLE",
      {
        notFoundCode: "CONTENT_NOT_FOUND",
        forbiddenCode: "REPOSITORY_NOT_ACCESSIBLE",
      },
    );
    const commitTree = record(commit.tree);
    if (typeof commit.sha !== "string" || commit.sha !== commitSha || typeof commitTree?.sha !== "string") {
      throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned an invalid commit");
    }

    let treeSha = commitTree.sha;
    const segments = path ? path.split("/") : [];
    for (let index = 0; index <= segments.length; index += 1) {
      const entries = await this.getTree(accessToken, prefix, treeSha);
      if (index === segments.length) {
        return {
          kind: "directory",
          repositoryId: repository.id,
          path,
          ref: repository.defaultBranch,
          commitSha,
          items: directoryItems(entries, path),
        };
      }
      const segment = segments[index];
      const entry = entries.find((candidate) => candidate.path === segment);
      if (!entry) {
        throw new BrokerProblem(404, "CONTENT_NOT_FOUND", "The requested path was not found");
      }
      const entryPath = segments.slice(0, index + 1).join("/");
      if (index < segments.length - 1) {
        if (entry.type !== "tree" || entry.mode !== "040000") {
          throw new BrokerProblem(404, "CONTENT_NOT_FOUND", "The requested path was not found");
        }
        treeSha = entry.sha;
        continue;
      }
      if (entry.type === "tree" && entry.mode === "040000") {
        treeSha = entry.sha;
        continue;
      }
      return this.getSourceFile(accessToken, prefix, repository, entryPath, commitSha, entry);
    }
    throw new BrokerProblem(404, "CONTENT_NOT_FOUND", "The requested path was not found");
  }

  private async getTree(accessToken: string, prefix: string, sha: string): Promise<GitTreeEntry[]> {
    const url = new URL(`${prefix}/git/trees/${encodeURIComponent(sha)}`, this.apiBase);
    const response = await githubFetch(
      url,
      { headers: { ...githubHeaders, Authorization: `Bearer ${accessToken}` } },
      "GITHUB_UNAVAILABLE",
    );
    const value = await parseJsonResponse<Record<string, unknown>>(response, "GITHUB_UNAVAILABLE", {
      notFoundCode: "CONTENT_NOT_FOUND",
      forbiddenCode: "REPOSITORY_NOT_ACCESSIBLE",
    });
    if (value.truncated === true) {
      throw new BrokerProblem(422, "DIRECTORY_TOO_LARGE", "The requested directory is too large");
    }
    if (value.truncated !== false || value.sha !== sha || !Array.isArray(value.tree)) {
      throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned an invalid directory");
    }
    if (value.tree.length > maxCollectionItems) {
      throw new BrokerProblem(422, "DIRECTORY_TOO_LARGE", "The requested directory is too large");
    }
    return value.tree.map(parseTreeEntryOrThrow);
  }

  private async getSourceFile(
    accessToken: string,
    prefix: string,
    repository: RepositoryItem,
    path: string,
    commitSha: string,
    entry: GitTreeEntry,
  ): Promise<SourceFile> {
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new BrokerProblem(415, "UNSUPPORTED_FILE_TYPE", "Only regular Mermaid or Markdown files can be opened");
    }
    if (!isSupportedPath(path)) {
      throw new BrokerProblem(415, "UNSUPPORTED_FILE_TYPE", "Only .mmd, .mermaid, and .md files can be opened");
    }
    if (entry.size === null || entry.size > maxSourceBytes) {
      throw new BrokerProblem(413, "FILE_TOO_LARGE", "The selected source file is too large");
    }
    const url = new URL(`${prefix}/git/blobs/${encodeURIComponent(entry.sha)}`, this.apiBase);
    const response = await githubFetch(
      url,
      { headers: { ...githubHeaders, Authorization: `Bearer ${accessToken}` } },
      "GITHUB_UNAVAILABLE",
    );
    const value = await parseJsonResponse<Record<string, unknown>>(response, "GITHUB_UNAVAILABLE", {
      notFoundCode: "CONTENT_NOT_FOUND",
      forbiddenCode: "REPOSITORY_NOT_ACCESSIBLE",
    });
    if (
      value.sha !== entry.sha ||
      value.encoding !== "base64" ||
      typeof value.content !== "string" ||
      typeof value.size !== "number" ||
      value.size !== entry.size ||
      value.size > maxSourceBytes
    ) {
      throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned an invalid source blob");
    }
    let bytes: Uint8Array;
    try {
      const binary = atob(value.content.replaceAll(/\s/gu, ""));
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned an invalid source blob");
    }
    if (bytes.byteLength !== entry.size) {
      throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned an invalid source blob");
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      throw new BrokerProblem(415, "INVALID_TEXT_FILE", "The selected file is not valid UTF-8 text");
    }
    return {
      kind: "file",
      repositoryId: repository.id,
      path,
      ref: repository.defaultBranch,
      commitSha,
      blobSha: entry.sha,
      size: bytes.byteLength,
      source,
    };
  }
}

interface GitTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function parseTreeEntryOrThrow(raw: unknown): GitTreeEntry {
  const value = record(raw);
  if (
    !value ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    value.path.includes("/") ||
    value.path.includes("\0") ||
    typeof value.mode !== "string" ||
    typeof value.type !== "string" ||
    typeof value.sha !== "string" ||
    !(
      (typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0) ||
      value.size === undefined
    )
  ) {
    throw new BrokerProblem(502, "GITHUB_UNAVAILABLE", "GitHub returned an invalid directory");
  }
  return {
    path: value.path,
    mode: value.mode,
    type: value.type,
    sha: value.sha,
    size: typeof value.size === "number" ? value.size : null,
  };
}

function directoryItems(entries: GitTreeEntry[], parentPath: string): DirectoryItem[] {
  return entries
    .filter((entry) => entry.type === "tree" || entry.type === "blob")
    .map((entry) => {
      const path = parentPath ? `${parentPath}/${entry.path}` : entry.path;
      const directory = entry.type === "tree" && entry.mode === "040000";
      const regularFile = entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
      return {
        name: entry.path,
        path,
        type: directory ? "directory" as const : "file" as const,
        sha: entry.sha,
        size: directory ? null : entry.size,
        supported: directory || Boolean(regularFile && entry.size !== null && entry.size <= maxSourceBytes && isSupportedPath(path)),
      };
    })
    .sort(
      (left, right) =>
        (left.type === right.type ? 0 : left.type === "directory" ? -1 : 1) ||
        left.name.localeCompare(right.name, "en", { sensitivity: "base" }) ||
        left.sha.localeCompare(right.sha),
    );
}

function isSupportedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return supportedExtensions.some((extension) => lower.endsWith(extension));
}

function hasNextPage(link: string | null): boolean {
  return link?.split(",").some(
    (part) => /;\s*rel\s*=\s*"next"(?:\s*;|\s*$)/u.test(part.trim()),
  ) ?? false;
}

function parseInstallation(raw: unknown): InstallationItem | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const account = value.account;
  if (!account || typeof account !== "object") return null;
  const accountValue = account as Record<string, unknown>;
  if (
    typeof value.id !== "number" ||
    (value.repository_selection !== "all" && value.repository_selection !== "selected") ||
    typeof accountValue.id !== "number" ||
    typeof accountValue.login !== "string" ||
    typeof accountValue.avatar_url !== "string" ||
    typeof accountValue.type !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    account: {
      id: accountValue.id,
      login: accountValue.login,
      avatarUrl: accountValue.avatar_url,
      type: accountValue.type,
    },
    repositorySelection: value.repository_selection,
    suspendedAt: typeof value.suspended_at === "string" ? value.suspended_at : null,
  };
}

function parseRepository(raw: unknown, installationId: number): RepositoryItem | null {
  const value = record(raw);
  const owner = record(value?.owner);
  if (
    !value ||
    !owner ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.includes("/") ||
    typeof value.full_name !== "string" ||
    typeof owner.login !== "string" ||
    owner.login.length === 0 ||
    owner.login.includes("/") ||
    value.full_name !== `${owner.login}/${value.name}` ||
    typeof owner.avatar_url !== "string" ||
    typeof value.private !== "boolean" ||
    typeof value.default_branch !== "string" ||
    value.default_branch.length === 0
  ) {
    return null;
  }
  return {
    id: value.id,
    installationId,
    name: value.name,
    fullName: value.full_name,
    owner: { login: owner.login, avatarUrl: owner.avatar_url },
    private: value.private,
    defaultBranch: value.default_branch,
  };
}
