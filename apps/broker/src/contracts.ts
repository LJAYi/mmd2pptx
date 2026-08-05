export interface BrokerEnv {
  OAUTH_TRANSACTIONS: DurableObjectNamespace;
  AUTH_SESSIONS: DurableObjectNamespace;
  AUTH_RATE_LIMITER: RateLimit;
  SESSION_RATE_LIMITER: RateLimit;
  ALLOWED_ORIGINS: string;
  BROKER_PUBLIC_URL: string;
  GITHUB_API_BASE_URL: string;
  GITHUB_OAUTH_BASE_URL: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_SLUG: string;
  SESSION_ENCRYPTION_KEY: string;
}

export interface GitHubTokenSet {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  tokenType: string;
  scope: string;
}

export interface GitHubActor {
  id: number;
  login: string;
  avatarUrl: string;
}

export interface StoredSession {
  encryptedTokens: string;
  actor: GitHubActor;
  createdAt: number;
  expiresAt: number;
  idleExpiresAt: number;
  refreshLease?: {
    id: string;
    expiresAt: number;
  };
}

export interface InstallationItem {
  id: number;
  account: {
    id: number;
    login: string;
    avatarUrl: string;
    type: string;
  };
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
}

export interface RepositoryItem {
  id: number;
  installationId: number;
  name: string;
  fullName: string;
  owner: {
    login: string;
    avatarUrl: string;
  };
  private: boolean;
  defaultBranch: string;
}

export interface DirectoryItem {
  name: string;
  path: string;
  type: "directory" | "file";
  sha: string;
  size: number | null;
  supported: boolean;
}

export interface DirectoryPage extends CollectionPage<DirectoryItem> {
  kind: "directory";
  repositoryId: number;
  path: string;
  ref: string;
  commitSha: string;
}

export interface SourceFile {
  kind: "file";
  repositoryId: number;
  path: string;
  ref: string;
  commitSha: string;
  blobSha: string;
  size: number;
  source: string;
}

export interface CollectionPage<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}
