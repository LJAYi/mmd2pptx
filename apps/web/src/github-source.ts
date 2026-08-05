const AUTH_MESSAGE_TYPE = "mmd2pptx:github-auth";
const MAX_LINES = 5_000;
const MAX_STATEMENTS = 2_000;
const MAX_LINE_BYTES = 16 * 1024;

export interface GitHubSourceProvenance {
  installationId: number;
  repositoryId: number;
  repository: string;
  path: string;
  ref: string;
  commitSha: string;
  blobSha: string;
}

interface Actor {
  id: number;
  login: string;
  avatarUrl: string;
}

interface Session {
  signed_in: true;
  actor: Actor;
  expires_at: string;
  install_url: string;
}

interface Installation {
  id: number;
  account: { id: number; login: string; avatarUrl: string; type: string };
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
}

interface Repository {
  id: number;
  installationId: number;
  name: string;
  fullName: string;
  owner: { login: string; avatarUrl: string };
  private: boolean;
  defaultBranch: string;
}

interface DirectoryEntry {
  name: string;
  path: string;
  type: "directory" | "file";
  sha: string;
  size: number | null;
  supported: boolean;
}

interface DirectoryResponse extends CollectionPage<DirectoryEntry> {
  kind: "directory";
  repositoryId: number;
  path: string;
  ref: string;
  commitSha: string;
}

interface FileResponse {
  kind: "file";
  repositoryId: number;
  path: string;
  ref: string;
  commitSha: string;
  blobSha: string;
  size: number | null;
  source: string;
}

interface CollectionPage<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

interface BrokerProblem {
  code?: string;
  detail?: string;
  reset_at?: string;
  title?: string;
}

interface MarkdownBlock {
  label: string;
  source: string;
}

export interface GitHubSourcePickerOptions {
  brokerOrigin?: string;
  button: HTMLButtonElement;
  dialog: HTMLDialogElement;
  onOpenSource: (source: string, provenance: GitHubSourceProvenance) => boolean;
}

export class GitHubSourcePicker {
  private readonly brokerOrigin: string | null;
  private readonly button: HTMLButtonElement;
  private readonly dialog: HTMLDialogElement;
  private readonly onOpenSource: GitHubSourcePickerOptions["onOpenSource"];
  private sessionHandle: string | null = null;
  private session: Session | null = null;
  private verifier: string | null = null;
  private authorizationPopup: Window | null = null;
  private selectedInstallation: Installation | null = null;
  private selectedRepository: Repository | null = null;
  private path = "";
  private pickerGeneration = 0;
  private busy = false;
  private status = "Connect GitHub to open a Mermaid file from a repository.";
  private error = "";
  private installations: Installation[] = [];
  private repositories: Repository[] = [];
  private entries: DirectoryEntry[] = [];
  private markdownBlocks: MarkdownBlock[] = [];
  private pendingFile: FileResponse | null = null;

  constructor(options: GitHubSourcePickerOptions) {
    this.brokerOrigin = normalizeBrokerOrigin(options.brokerOrigin);
    this.button = options.button;
    this.dialog = options.dialog;
    this.onOpenSource = options.onOpenSource;

    if (!this.brokerOrigin) {
      this.button.disabled = true;
      this.button.title = "GitHub integration is not configured for this deployment.";
    }

    this.button.addEventListener("click", () => this.open());
    this.dialog.addEventListener("click", (event) => this.handleClick(event));
    this.dialog.addEventListener("cancel", () => this.close());
    window.addEventListener("message", (event) => void this.handleAuthorizationMessage(event));
    this.render();
  }

  private open(): void {
    if (!this.brokerOrigin) return;
    this.error = "";
    if (!this.dialog.open) this.dialog.showModal();
    this.render();
  }

  private close(): void {
    this.pickerGeneration += 1;
    if (this.dialog.open) this.dialog.close();
  }

  private async handleClick(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLElement>("[data-github-action]")?.dataset.githubAction;
    if (this.busy && action !== "close") return;

    if (action === "close") return this.close();
    if (action === "connect") return void this.connect();
    if (action === "logout") return void this.logout();
    if (action === "refresh-installations") return void this.loadInstallations();
    if (action === "back-installations") {
      this.selectedInstallation = null;
      this.selectedRepository = null;
      this.repositories = [];
      this.entries = [];
      this.render();
      return;
    }
    if (action === "back-repositories") {
      this.selectedRepository = null;
      this.path = "";
      this.entries = [];
      this.render();
      return;
    }
    if (action === "back-directory") return void this.loadDirectory(this.path);
    if (action === "directory-up") return void this.loadDirectory(parentPath(this.path));

    const installationId = target.closest<HTMLElement>("[data-installation-id]")?.dataset.installationId;
    if (installationId) {
      const installation = this.installations.find((item) => item.id === Number(installationId));
      if (installation) void this.selectInstallation(installation);
      return;
    }
    const repositoryId = target.closest<HTMLElement>("[data-repository-id]")?.dataset.repositoryId;
    if (repositoryId) {
      const repository = this.repositories.find((item) => item.id === Number(repositoryId));
      if (repository) void this.selectRepository(repository);
      return;
    }
    const entryPath = target.closest<HTMLElement>("[data-entry-path]")?.dataset.entryPath;
    if (entryPath) {
      const entry = this.entries.find((item) => item.path === entryPath);
      if (entry?.type === "directory") void this.loadDirectory(entry.path);
      else if (entry?.supported) void this.loadFile(entry.path);
      return;
    }
    const blockIndex = target.closest<HTMLElement>("[data-block-index]")?.dataset.blockIndex;
    if (blockIndex !== undefined && this.pendingFile) {
      this.openFileSource(this.markdownBlocks[Number(blockIndex)]?.source ?? "", this.pendingFile);
    }
  }

  private async connect(): Promise<void> {
    if (!this.brokerOrigin) return;
    this.error = "";
    this.authorizationPopup = window.open(
      "about:blank",
      "mmd2pptx-github-auth",
      "popup,width=720,height=760",
    );
    if (!this.authorizationPopup) {
      this.verifier = null;
      this.error = "The authorization window was blocked. Allow pop-ups and try again.";
      this.render();
      return;
    }
    this.busy = true;
    this.status = "Preparing secure GitHub authorization…";
    this.render();
    try {
      this.verifier = createPkceVerifier();
      const challenge = await createPkceChallenge(this.verifier);
      const url = new URL("/auth/github/start", this.brokerOrigin);
      url.searchParams.set("return_origin", window.location.origin);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      if (this.authorizationPopup.closed) throw new Error("The authorization window was closed.");
      this.authorizationPopup.location.replace(url);
      this.status = "Complete authorization in the GitHub window.";
    } catch (error) {
      this.authorizationPopup?.close();
      this.authorizationPopup = null;
      this.verifier = null;
      this.error = error instanceof Error ? error.message : "GitHub authorization could not start.";
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async handleAuthorizationMessage(event: MessageEvent): Promise<void> {
    if (!this.brokerOrigin || event.origin !== this.brokerOrigin || event.source !== this.authorizationPopup) {
      return;
    }
    const data = event.data as { type?: unknown; exchangeCode?: unknown } | null;
    if (
      !data || data.type !== AUTH_MESSAGE_TYPE || typeof data.exchangeCode !== "string" ||
      !this.verifier
    ) return;

    const verifier = this.verifier;
    this.verifier = null;
    this.authorizationPopup = null;
    await this.runBusy("Finishing GitHub connection…", async () => {
      const result = await this.request<{ session_handle: string; session: Session }>(
        "/auth/session/exchange",
        {
          method: "POST",
          body: JSON.stringify({ exchangeCode: data.exchangeCode, codeVerifier: verifier }),
          headers: { "Content-Type": "application/json" },
        },
        false,
      );
      this.sessionHandle = result.session_handle;
      this.session = result.session;
      this.status = `Connected as ${result.session.actor.login}.`;
      await this.loadInstallations(false);
    });
  }

  private async logout(): Promise<void> {
    await this.runBusy("Signing out…", async () => {
      if (this.sessionHandle) await this.request("/auth/logout", { method: "POST" });
      this.clearSession();
      this.status = "Signed out. Your local diagram is unchanged.";
    });
  }

  private async loadInstallations(showBusy = true): Promise<void> {
    const load = async () => {
      this.installations = await this.loadAllPages<Installation>("/api/github/installations");
      this.selectedInstallation = null;
      this.selectedRepository = null;
      this.repositories = [];
      this.entries = [];
      this.markdownBlocks = [];
      this.pendingFile = null;
      this.status = this.installations.length
        ? "Choose a GitHub App installation."
        : "No accessible installation was found. Install the app, then refresh.";
    };
    if (showBusy) await this.runBusy("Checking GitHub installations…", load);
    else await load();
  }

  private async selectInstallation(installation: Installation): Promise<void> {
    this.selectedInstallation = installation;
    await this.runBusy("Loading repositories…", async () => {
      this.repositories = await this.loadAllPages<Repository>(
        `/api/github/installations/${installation.id}/repositories`,
      );
      this.status = this.repositories.length ? "Choose a repository." : "No accessible repositories found.";
    });
  }

  private async selectRepository(repository: Repository): Promise<void> {
    this.selectedRepository = repository;
    await this.loadDirectory("");
  }

  private async loadDirectory(path: string): Promise<void> {
    const installation = this.selectedInstallation;
    const repository = this.selectedRepository;
    if (!installation || !repository) return;
    await this.runBusy(path ? `Opening ${path}…` : "Opening repository…", async () => {
      const endpoint = this.contentsEndpoint(installation.id, repository.id, path);
      const first = await this.request<DirectoryResponse>(endpoint);
      if (first.kind !== "directory") throw new Error("GitHub returned a file where a directory was expected.");
      const items = [...first.items];
      let cursor = first.next_cursor;
      while (first.has_more && cursor) {
        const next = await this.request<DirectoryResponse>(`${endpoint}&cursor=${encodeURIComponent(cursor)}`);
        items.push(...next.items);
        cursor = next.next_cursor;
        if (!next.has_more) break;
      }
      this.path = path;
      this.entries = items;
      this.markdownBlocks = [];
      this.pendingFile = null;
      this.status = items.length ? "Choose a folder or Mermaid source file." : "This folder is empty.";
    });
  }

  private async loadFile(path: string): Promise<void> {
    const installation = this.selectedInstallation;
    const repository = this.selectedRepository;
    if (!installation || !repository) return;
    const pickerGeneration = this.pickerGeneration;
    await this.runBusy(`Opening ${path}…`, async () => {
      const file = await this.request<FileResponse>(this.contentsEndpoint(installation.id, repository.id, path));
      if (pickerGeneration !== this.pickerGeneration || !this.dialog.open) return;
      if (file.kind !== "file") throw new Error("GitHub returned a directory where a file was expected.");
      if (/\.md$/iu.test(file.path)) {
        this.markdownBlocks = extractMermaidMarkdownBlocks(file.source);
        this.pendingFile = file;
        if (this.markdownBlocks.length === 0) {
          this.status = "This Markdown file has no Mermaid code blocks.";
        } else if (this.markdownBlocks.length === 1) {
          this.openFileSource(this.markdownBlocks[0]!.source, file);
        } else {
          this.status = "Choose a Mermaid block from this Markdown file.";
        }
      } else {
        this.openFileSource(file.source, file);
      }
    });
  }

  private openFileSource(source: string, file: FileResponse): void {
    const repository = this.selectedRepository;
    const installation = this.selectedInstallation;
    if (!repository || !installation) return;
    const budgetError = mermaidComplexityError(source);
    if (budgetError) {
      this.status = budgetError;
      return;
    }
    const opened = this.onOpenSource(source, {
      installationId: installation.id,
      repositoryId: repository.id,
      repository: repository.fullName,
      path: file.path,
      ref: file.ref,
      commitSha: file.commitSha,
      blobSha: file.blobSha,
    });
    if (opened) this.close();
    else this.status = "Your current diagram was kept. Choose a file whenever you are ready.";
  }

  private contentsEndpoint(installationId: number, repositoryId: number, path: string): string {
    return `/api/github/installations/${installationId}/repositories/${repositoryId}/contents?path=${encodeURIComponent(path)}`;
  }

  private async loadAllPages<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    do {
      const delimiter = path.includes("?") ? "&" : "?";
      const page: CollectionPage<T> = await this.request<CollectionPage<T>>(
        cursor ? `${path}${delimiter}cursor=${encodeURIComponent(cursor)}` : path,
      );
      items.push(...page.items);
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return items;
  }

  private async request<T = void>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    if (!this.brokerOrigin) throw new Error("GitHub integration is not configured.");
    const headers = new Headers(init.headers);
    if (authenticated) {
      if (!this.sessionHandle) throw new Error("Connect GitHub to continue.");
      headers.set("Authorization", `Bearer ${this.sessionHandle}`);
    }
    const response = await fetch(new URL(path, this.brokerOrigin), { ...init, headers });
    if (!response.ok) {
      let problem: BrokerProblem = {};
      try { problem = await response.json() as BrokerProblem; } catch { /* non-JSON upstream error */ }
      const error = new Error(problem.detail || problem.title || `GitHub request failed (${response.status}).`);
      Object.assign(error, { code: problem.code, resetAt: problem.reset_at, status: response.status });
      throw error;
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private async runBusy(status: string, task: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.error = "";
    this.status = status;
    this.render();
    try {
      await task();
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
      if (code === "SESSION_EXPIRED" || code === "SESSION_REQUIRED") {
        this.clearSession();
        this.error = "Your GitHub session expired. Connect again to continue.";
      } else if (code === "INSTALLATION_REVOKED" || code === "INVALID_INSTALLATION") {
        this.selectedInstallation = null;
        this.selectedRepository = null;
        this.error = "This installation is no longer available. Refresh or reinstall the GitHub App.";
      } else if (code === "INSUFFICIENT_PERMISSION") {
        this.selectedInstallation = null;
        this.selectedRepository = null;
        this.repositories = [];
        this.entries = [];
        this.error = "The GitHub App needs read-only Contents permission. Approve the permission update and reconnect.";
      } else if (code === "REPOSITORY_NOT_AVAILABLE" || code === "REPOSITORY_ACCESS_CHANGED") {
        this.selectedRepository = null;
        this.entries = [];
        this.error = "Repository access changed. Choose the repository again or update the App installation.";
      } else if (code === "GITHUB_RATE_LIMITED") {
        const resetAt = typeof error === "object" && error && "resetAt" in error
          ? String((error as { resetAt?: unknown }).resetAt ?? "")
          : "";
        this.error = resetAt
          ? `GitHub's rate limit was reached. Try again after ${new Date(resetAt).toLocaleTimeString()}.`
          : "GitHub's rate limit was reached. Wait a moment and try again.";
      } else if (code === "GITHUB_UNAVAILABLE") {
        this.error = "GitHub is temporarily unavailable. Your local diagram is unchanged.";
      } else {
        this.error = error instanceof Error ? error.message : "The GitHub request failed.";
      }
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private clearSession(): void {
    this.sessionHandle = null;
    this.session = null;
    this.installations = [];
    this.repositories = [];
    this.entries = [];
    this.selectedInstallation = null;
    this.selectedRepository = null;
    this.path = "";
    this.markdownBlocks = [];
    this.pendingFile = null;
  }

  private render(): void {
    const body = this.dialog.querySelector<HTMLElement>("[data-github-picker-body]");
    const status = this.dialog.querySelector<HTMLElement>("[data-github-picker-status]");
    const account = this.dialog.querySelector<HTMLElement>("[data-github-picker-account]");
    if (!body || !status || !account) return;

    status.textContent = this.error || this.status;
    status.classList.toggle("is-error", Boolean(this.error));
    status.setAttribute("aria-busy", String(this.busy));
    account.innerHTML = this.session
      ? `<span>Signed in as <strong>${escapeHtml(this.session.actor.login)}</strong></span><button type="button" data-github-action="logout">Sign out</button>`
      : "";

    if (!this.session) {
      body.innerHTML = `<div class="github-connect-state"><div class="github-mark" aria-hidden="true">GH</div><h3>Open Mermaid from GitHub</h3><p>Authorize selected repositories without sharing a personal access token. Files are loaded into this browser and exports stay local.</p><button class="github-primary" type="button" data-github-action="connect">Connect GitHub</button></div>`;
      return;
    }
    if (this.markdownBlocks.length > 1 && this.pendingFile) {
      body.innerHTML = `<div class="github-picker-nav"><button type="button" data-github-action="back-directory">← Folder</button><span>${escapeHtml(this.pendingFile.path)}</span></div><ul class="github-source-list">${this.markdownBlocks.map((block, index) => `<li><button type="button" data-block-index="${index}"><span class="github-entry-icon">◇</span><span><strong>${escapeHtml(block.label)}</strong><small>${lineCount(block.source)} lines</small></span></button></li>`).join("")}</ul>`;
      return;
    }
    if (!this.selectedInstallation) {
      const installUrl = safeGitHubInstallUrl(this.session.install_url);
      body.innerHTML = `${installUrl ? `<div class="github-install-row"><a href="${escapeHtml(installUrl)}" target="_blank" rel="noopener noreferrer">Add repositories ↗</a><button type="button" data-github-action="refresh-installations">Refresh</button></div>` : ""}<ul class="github-source-list">${this.installations.map((item) => `<li><button type="button" data-installation-id="${item.id}" ${item.suspendedAt ? "disabled" : ""}><span class="github-avatar">${escapeHtml(initials(item.account.login))}</span><span><strong>${escapeHtml(item.account.login)}</strong><small>${item.suspendedAt ? "Suspended" : `${escapeHtml(item.account.type)} · ${item.repositorySelection} repositories`}</small></span><i>›</i></button></li>`).join("")}</ul>`;
      return;
    }
    if (!this.selectedRepository) {
      body.innerHTML = `<div class="github-picker-nav"><button type="button" data-github-action="back-installations">← Installations</button><span>${escapeHtml(this.selectedInstallation.account.login)}</span></div><ul class="github-source-list">${this.repositories.map((item) => `<li><button type="button" data-repository-id="${item.id}"><span class="github-entry-icon">▱</span><span><strong>${escapeHtml(item.fullName)}</strong><small>${item.private ? "Private" : "Public"} · ${escapeHtml(item.defaultBranch)}</small></span><i>›</i></button></li>`).join("")}</ul>`;
      return;
    }

    const breadcrumbs = this.path ? this.path.split("/") : [];
    body.innerHTML = `<div class="github-picker-nav"><button type="button" data-github-action="back-repositories">← Repositories</button><span>${escapeHtml(this.selectedRepository.fullName)} / ${breadcrumbs.map(escapeHtml).join(" / ")}</span></div>${this.path ? `<button class="github-directory-up" type="button" data-github-action="directory-up">↰ Parent folder</button>` : ""}<ul class="github-source-list">${this.entries.map((entry) => `<li><button type="button" data-entry-path="${escapeHtml(entry.path)}" ${entry.type === "file" && !entry.supported ? "disabled" : ""}><span class="github-entry-icon">${entry.type === "directory" ? "▱" : "◇"}</span><span><strong>${escapeHtml(entry.name)}</strong><small>${entry.type === "directory" ? "Folder" : entry.supported ? "Mermaid source" : "Unsupported file"}</small></span>${entry.type === "directory" ? "<i>›</i>" : ""}</button></li>`).join("")}</ul>`;
  }
}

export function normalizeBrokerOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.pathname !== "/" || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function extractMermaidMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid(?:[ \t]+.*)?$/iu.exec(lines[index] ?? "");
    if (!opening?.[1]) continue;
    const fence = opening[1];
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`, "u");
    const content: string[] = [];
    let closed = false;
    for (index += 1; index < lines.length; index += 1) {
      if (closing.test(lines[index] ?? "")) {
        closed = true;
        break;
      }
      content.push(lines[index] ?? "");
    }
    if (!closed) break;
    const source = content.join("\n").trim();
    if (source) blocks.push({ label: `Mermaid block ${blocks.length + 1}`, source });
  }
  return blocks;
}

export function mermaidComplexityError(source: string): string | null {
  const lines = source.split(/\r?\n/u);
  if (lines.length > MAX_LINES) return `This diagram has more than ${MAX_LINES.toLocaleString()} lines and was not opened.`;
  const encoder = new TextEncoder();
  if (lines.some((line) => encoder.encode(line).byteLength > MAX_LINE_BYTES)) {
    return "This diagram contains a line larger than 16 KiB and was not opened.";
  }
  const statements = lines.reduce((count, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%")) return count;
    return count + Math.max(1, line.split(";").filter((part) => part.trim()).length);
  }, 0);
  if (statements > MAX_STATEMENTS) return `This diagram has more than ${MAX_STATEMENTS.toLocaleString()} statements and was not opened.`;
  return null;
}

export function createPkceVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return base64Url(bytes);
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function lineCount(source: string): number {
  return source ? source.split("\n").length : 0;
}

function initials(login: string): string {
  return login.slice(0, 2).toUpperCase();
}

function safeGitHubInstallUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" && url.pathname.startsWith("/apps/")
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]!);
}
