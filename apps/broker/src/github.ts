import type { GitHubActor, GitHubTokenSet, InstallationItem } from "./contracts";
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

async function parseJsonResponse<T>(response: Response, code: string): Promise<T> {
  if (!response.ok) {
    if (
      response.status === 429 ||
      (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0")
    ) {
      throw new BrokerProblem(429, "GITHUB_RATE_LIMITED", "GitHub rate limit exceeded");
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
