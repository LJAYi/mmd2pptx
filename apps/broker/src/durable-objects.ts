import type {
  CollectionPage,
  DirectoryItem,
  DirectoryPage,
  InstallationItem,
  RepositoryItem,
  StoredSession,
} from "./contracts";
import {
  constantTimeEqual,
  isPkceVerifier,
  randomToken,
  sha256Base64Url,
} from "./crypto";

const transactionTtlMs = 5 * 60 * 1000;
const snapshotTtlMs = 5 * 60 * 1000;
const refreshLeaseTtlMs = 30 * 1000;
const sessionIdleMs = 30 * 60 * 1000;
const pageSize = 50;

interface OAuthTransaction {
  state: string;
  challenge: string;
  returnOrigin: string;
  createdAt: number;
  expiresAt: number;
  authorizationCode?: string;
  exchangeSecret?: string;
  consumedAt?: number;
}

interface InstallationSnapshot {
  id: string;
  expiresAt: number;
  length: number;
  cursors: Record<string, number>;
}

interface RepositorySnapshot extends InstallationSnapshot {
  installationId: number;
}

interface DirectorySnapshot extends InstallationSnapshot {
  queryKey: string;
  metadata: Omit<DirectoryPage, keyof CollectionPage<DirectoryItem>>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function body<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export class OAuthTransactionObject implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/create") {
      const input = await body<{ state: string; challenge: string; returnOrigin: string }>(request);
      const existing = await this.state.storage.get<OAuthTransaction>("transaction");
      if (existing) return json({ code: "TRANSACTION_EXISTS" }, 409);
      const now = Date.now();
      const transaction: OAuthTransaction = {
        state: input.state,
        challenge: input.challenge,
        returnOrigin: input.returnOrigin,
        createdAt: now,
        expiresAt: now + transactionTtlMs,
      };
      await this.state.storage.put("transaction", transaction);
      await this.state.storage.setAlarm(transaction.expiresAt);
      return json({ ok: true }, 201);
    }

    if (request.method === "POST" && path === "/callback") {
      const input = await body<{ code: string }>(request);
      const result = await this.state.storage.transaction(async (storage) => {
        const transaction = await storage.get<OAuthTransaction>("transaction");
        if (!transaction || transaction.expiresAt <= Date.now()) return "expired";
        if (transaction.authorizationCode || transaction.consumedAt) return "replayed";
        transaction.authorizationCode = input.code;
        transaction.exchangeSecret = randomToken();
        await storage.put("transaction", transaction);
        return "stored";
      });
      if (result === "expired") return json({ code: "TRANSACTION_EXPIRED" }, 410);
      if (result === "replayed") return json({ code: "TRANSACTION_REPLAYED" }, 409);
      return json({ ok: true });
    }

    if (request.method === "GET" && path === "/complete") {
      const transaction = await this.activeTransaction();
      if (!transaction?.authorizationCode || !transaction.exchangeSecret || transaction.consumedAt) {
        return json({ code: "TRANSACTION_NOT_READY" }, 409);
      }
      return json({
        exchangeCode: `${transaction.state}.${transaction.exchangeSecret}`,
        returnOrigin: transaction.returnOrigin,
      });
    }

    if (request.method === "POST" && path === "/exchange") {
      const input = await body<{ exchangeCode: string; verifier: string; origin: string }>(request);
      const transaction = await this.activeTransaction();
      if (!transaction?.authorizationCode || !transaction.exchangeSecret) {
        return json({ code: "TRANSACTION_EXPIRED" }, 410);
      }
      if (transaction.consumedAt) return json({ code: "TRANSACTION_REPLAYED" }, 409);
      if (!isPkceVerifier(input.verifier)) return json({ code: "PKCE_MISMATCH" }, 401);
      const expectedExchangeCode = `${transaction.state}.${transaction.exchangeSecret}`;
      const challenge = await sha256Base64Url(input.verifier);
      if (
        !constantTimeEqual(input.exchangeCode, expectedExchangeCode) ||
        !constantTimeEqual(challenge, transaction.challenge) ||
        !constantTimeEqual(input.origin, transaction.returnOrigin)
      ) {
        return json({ code: "PKCE_MISMATCH" }, 401);
      }
      const consumed = await this.state.storage.transaction(async (storage) => {
        const current = await storage.get<OAuthTransaction>("transaction");
        if (!current || current.consumedAt) return false;
        current.consumedAt = Date.now();
        await storage.put("transaction", current);
        return true;
      });
      if (!consumed) return json({ code: "TRANSACTION_REPLAYED" }, 409);
      return json({
        authorizationCode: transaction.authorizationCode,
        returnOrigin: transaction.returnOrigin,
      });
    }

    return json({ code: "NOT_FOUND" }, 404);
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }

  private async activeTransaction(): Promise<OAuthTransaction | null> {
    const transaction = await this.state.storage.get<OAuthTransaction>("transaction");
    if (!transaction || transaction.expiresAt <= Date.now()) {
      if (transaction) await this.state.storage.deleteAll();
      return null;
    }
    return transaction;
  }
}

export class AuthSessionObject implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/create") {
      const session = await body<StoredSession>(request);
      if (await this.state.storage.get("session")) return json({ code: "SESSION_EXISTS" }, 409);
      await this.state.storage.put("session", session);
      await this.state.storage.setAlarm(Math.min(session.expiresAt, session.idleExpiresAt));
      return json({ ok: true }, 201);
    }

    if (request.method === "GET" && path === "/session") {
      const session = await this.activeSession(true);
      return session ? json(session) : json({ code: "SESSION_REQUIRED" }, 401);
    }

    if (request.method === "PUT" && path === "/tokens") {
      const input = await body<{ encryptedTokens: string; idleExpiresAt: number; lease: string }>(request);
      const session = await this.state.storage.get<StoredSession>("session");
      if (!session || session.expiresAt <= Date.now() || session.idleExpiresAt <= Date.now()) {
        return json({ code: "SESSION_REQUIRED" }, 401);
      }
      if (!session.refreshLease || !constantTimeEqual(session.refreshLease.id, input.lease)) {
        return json({ code: "REFRESH_LEASE_INVALID" }, 409);
      }
      session.encryptedTokens = input.encryptedTokens;
      session.idleExpiresAt = input.idleExpiresAt;
      delete session.refreshLease;
      await this.state.storage.put("session", session);
      const snapshots = await this.snapshotExpiries();
      await this.state.storage.setAlarm(
        Math.min(
          session.expiresAt,
          session.idleExpiresAt,
          ...snapshots,
        ),
      );
      return json({ ok: true });
    }

    if (request.method === "POST" && path === "/refresh/acquire") {
      const input = await body<{ encryptedTokens: string }>(request);
      const result = await this.state.storage.transaction(async (storage) => {
        const session = await storage.get<StoredSession>("session");
        const now = Date.now();
        if (!session || session.expiresAt <= now || session.idleExpiresAt <= now) {
          return { status: "missing" } as const;
        }
        if (session.encryptedTokens !== input.encryptedTokens) {
          return { status: "updated", session } as const;
        }
        if (session.refreshLease && session.refreshLease.expiresAt > now) {
          return { status: "busy" } as const;
        }
        const lease = randomToken();
        session.refreshLease = { id: lease, expiresAt: now + refreshLeaseTtlMs };
        await storage.put("session", session);
        return { status: "acquired", lease } as const;
      });
      if (result.status === "missing") return json({ code: "SESSION_REQUIRED" }, 401);
      if (result.status === "busy") return json({ code: "REFRESH_IN_PROGRESS" }, 409);
      return json(result);
    }

    if (request.method === "POST" && path === "/refresh/invalidate") {
      const input = await body<{ lease: string }>(request);
      const invalidated = await this.state.storage.transaction(async (storage) => {
        const session = await storage.get<StoredSession>("session");
        if (!session?.refreshLease || !constantTimeEqual(session.refreshLease.id, input.lease)) {
          return false;
        }
        await storage.delete("session");
        await storage.delete("installationSnapshot");
        return true;
      });
      if (invalidated) {
        await this.state.storage.deleteAll();
        return new Response(null, { status: 204 });
      }
      return json({ code: "REFRESH_LEASE_INVALID" }, 409);
    }

    if (request.method === "POST" && path === "/refresh/release") {
      const input = await body<{ lease: string }>(request);
      const released = await this.state.storage.transaction(async (storage) => {
        const session = await storage.get<StoredSession>("session");
        if (!session?.refreshLease || !constantTimeEqual(session.refreshLease.id, input.lease)) {
          return false;
        }
        delete session.refreshLease;
        await storage.put("session", session);
        return true;
      });
      return released ? new Response(null, { status: 204 }) : json({ code: "REFRESH_LEASE_INVALID" }, 409);
    }

    if (request.method === "DELETE" && path === "/session") {
      await this.state.storage.deleteAll();
      return new Response(null, { status: 204 });
    }

    if (request.method === "POST" && path === "/installations/create") {
      const input = await body<{ items: InstallationItem[] }>(request);
      const session = await this.activeSession(true);
      if (!session) return json({ code: "SESSION_REQUIRED" }, 401);
      const snapshot: InstallationSnapshot = {
        id: randomToken(),
        expiresAt: Date.now() + snapshotTtlMs,
        length: input.items.length,
        cursors: {},
      };
      const chunks = new Map<string, InstallationItem[]>();
      for (let offset = 0; offset < input.items.length; offset += pageSize) {
        chunks.set(
          this.snapshotPageKey(snapshot.id, offset),
          input.items.slice(offset, offset + pageSize),
        );
      }
      const page = this.page(snapshot, 0, input.items.slice(0, pageSize));
      await this.state.storage.transaction(async (storage) => {
        const previous = await storage.list({ prefix: "installationPage:" });
        if (previous.size > 0) await storage.delete([...previous.keys()]);
        if (chunks.size > 0) await storage.put(Object.fromEntries(chunks));
        await storage.put("installationSnapshot", snapshot);
      });
      await this.state.storage.setAlarm(
        Math.min(session.expiresAt, session.idleExpiresAt, snapshot.expiresAt),
      );
      return json(page);
    }

    if (request.method === "POST" && path === "/installations/page") {
      const input = await body<{ cursor: string }>(request);
      if (!(await this.activeSession(true))) return json({ code: "SESSION_REQUIRED" }, 401);
      const page = await this.state.storage.transaction(async (storage) => {
        const snapshot = await storage.get<InstallationSnapshot>("installationSnapshot");
        const offset = snapshot?.cursors[input.cursor];
        if (!snapshot || snapshot.expiresAt <= Date.now() || offset === undefined) return null;
        delete snapshot.cursors[input.cursor];
        const items =
          await storage.get<InstallationItem[]>(this.snapshotPageKey(snapshot.id, offset));
        if (!items) return null;
        const result = this.page(snapshot, offset, items);
        await storage.put("installationSnapshot", snapshot);
        return result;
      });
      return page ? json(page) : json({ code: "INVALID_CURSOR" }, 400);
    }

    if (request.method === "POST" && path === "/repositories/create") {
      const input = await body<{ installationId: number; items: RepositoryItem[] }>(request);
      const session = await this.activeSession(true);
      if (!session) return json({ code: "SESSION_REQUIRED" }, 401);
      const snapshot: RepositorySnapshot = {
        id: randomToken(),
        expiresAt: Date.now() + snapshotTtlMs,
        length: input.items.length,
        cursors: {},
        installationId: input.installationId,
      };
      const chunks = this.chunks("repositoryPage", snapshot.id, input.items);
      const page = this.page(snapshot, 0, input.items.slice(0, pageSize));
      await this.replaceSnapshot("repository", snapshot, chunks);
      await this.setSessionAlarm(session);
      return json(page);
    }

    if (request.method === "POST" && path === "/repositories/page") {
      const input = await body<{
        installationId: number;
        cursor: string;
        authorizedRepositoryIds: number[];
      }>(request);
      if (!(await this.activeSession(true))) return json({ code: "SESSION_REQUIRED" }, 401);
      const page = await this.state.storage.transaction(async (storage) => {
        const snapshot = await storage.get<RepositorySnapshot>("repositorySnapshot");
        const offset = snapshot?.cursors[input.cursor];
        if (
          !snapshot ||
          snapshot.expiresAt <= Date.now() ||
          snapshot.installationId !== input.installationId ||
          offset === undefined
        ) return null;
        delete snapshot.cursors[input.cursor];
        const items = await storage.get<RepositoryItem[]>(
          this.snapshotPageKey("repositoryPage", snapshot.id, offset),
        );
        if (!items) return null;
        const authorized = new Set(input.authorizedRepositoryIds);
        if (items.some((item) => !authorized.has(item.id))) return "access-changed" as const;
        const result = this.page(snapshot, offset, items);
        await storage.put("repositorySnapshot", snapshot);
        return result;
      });
      if (page === "access-changed") {
        return json({ code: "REPOSITORY_ACCESS_CHANGED" }, 409);
      }
      return page ? json(page) : json({ code: "INVALID_CURSOR" }, 400);
    }

    if (request.method === "POST" && path === "/directory/create") {
      const input = await body<{
        queryKey: string;
        items: DirectoryItem[];
        metadata: Omit<DirectoryPage, keyof CollectionPage<DirectoryItem>>;
      }>(request);
      const session = await this.activeSession(true);
      if (!session) return json({ code: "SESSION_REQUIRED" }, 401);
      const snapshot: DirectorySnapshot = {
        id: randomToken(),
        expiresAt: Date.now() + snapshotTtlMs,
        length: input.items.length,
        cursors: {},
        queryKey: input.queryKey,
        metadata: input.metadata,
      };
      const chunks = this.chunks("directoryPage", snapshot.id, input.items);
      const collection = this.page(snapshot, 0, input.items.slice(0, pageSize));
      await this.replaceSnapshot("directory", snapshot, chunks);
      await this.setSessionAlarm(session);
      return json({ ...snapshot.metadata, ...collection });
    }

    if (request.method === "POST" && path === "/directory/page") {
      const input = await body<{ queryKey: string; cursor: string }>(request);
      if (!(await this.activeSession(true))) return json({ code: "SESSION_REQUIRED" }, 401);
      const page = await this.state.storage.transaction(async (storage) => {
        const snapshot = await storage.get<DirectorySnapshot>("directorySnapshot");
        const offset = snapshot?.cursors[input.cursor];
        if (
          !snapshot ||
          snapshot.expiresAt <= Date.now() ||
          snapshot.queryKey !== input.queryKey ||
          offset === undefined
        ) return null;
        delete snapshot.cursors[input.cursor];
        const items = await storage.get<DirectoryItem[]>(
          this.snapshotPageKey("directoryPage", snapshot.id, offset),
        );
        if (!items) return null;
        const collection = this.page(snapshot, offset, items);
        await storage.put("directorySnapshot", snapshot);
        return { ...snapshot.metadata, ...collection };
      });
      return page ? json(page) : json({ code: "INVALID_CURSOR" }, 400);
    }

    return json({ code: "NOT_FOUND" }, 404);
  }

  async alarm(): Promise<void> {
    const session = await this.state.storage.get<StoredSession>("session");
    const now = Date.now();
    if (!session || session.expiresAt <= now || session.idleExpiresAt <= now) {
      await this.state.storage.deleteAll();
      return;
    }
    for (const collection of ["installation", "repository", "directory"] as const) {
      const snapshot = await this.state.storage.get<InstallationSnapshot>(`${collection}Snapshot`);
      if (snapshot && snapshot.expiresAt <= now) {
        const pages = await this.state.storage.list({ prefix: `${collection}Page:` });
        if (pages.size > 0) await this.state.storage.delete([...pages.keys()]);
        await this.state.storage.delete(`${collection}Snapshot`);
      }
    }
    await this.setSessionAlarm(session);
  }

  private async activeSession(touch: boolean): Promise<StoredSession | null> {
    const session = await this.state.storage.get<StoredSession>("session");
    const now = Date.now();
    if (!session || session.expiresAt <= now || session.idleExpiresAt <= now) {
      if (session) await this.state.storage.deleteAll();
      return null;
    }
    if (touch) {
      session.idleExpiresAt = Math.min(session.expiresAt, now + sessionIdleMs);
      await this.state.storage.put("session", session);
      await this.setSessionAlarm(session);
    }
    return session;
  }

  private page<T>(
    snapshot: InstallationSnapshot,
    offset: number,
    items: T[],
  ): CollectionPage<T> {
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < snapshot.length;
    const cursor = hasMore ? randomToken() : null;
    if (cursor) snapshot.cursors[cursor] = nextOffset;
    return { items, next_cursor: cursor, has_more: hasMore };
  }

  private chunks<T>(prefix: string, snapshotId: string, items: T[]): Map<string, T[]> {
    const chunks = new Map<string, T[]>();
    for (let offset = 0; offset < items.length; offset += pageSize) {
      chunks.set(
        this.snapshotPageKey(prefix, snapshotId, offset),
        items.slice(offset, offset + pageSize),
      );
    }
    return chunks;
  }

  private async replaceSnapshot<T extends InstallationSnapshot>(
    collection: "repository" | "directory",
    snapshot: T,
    chunks: Map<string, unknown>,
  ): Promise<void> {
    await this.state.storage.transaction(async (storage) => {
      const previous = await storage.list({ prefix: `${collection}Page:` });
      if (previous.size > 0) await storage.delete([...previous.keys()]);
      if (chunks.size > 0) await storage.put(Object.fromEntries(chunks));
      await storage.put(`${collection}Snapshot`, snapshot);
    });
  }

  private snapshotPageKey(snapshotId: string, offset: number): string;
  private snapshotPageKey(prefix: string, snapshotId: string, offset: number): string;
  private snapshotPageKey(first: string, second: string | number, third?: number): string {
    if (third === undefined) return `installationPage:${first}:${second}`;
    return `${first}:${second}:${third}`;
  }

  private async snapshotExpiries(): Promise<number[]> {
    const now = Date.now();
    const expiries: number[] = [];
    for (const key of ["installationSnapshot", "repositorySnapshot", "directorySnapshot"] as const) {
      const snapshot = await this.state.storage.get<InstallationSnapshot>(key);
      if (snapshot && snapshot.expiresAt > now) expiries.push(snapshot.expiresAt);
    }
    return expiries;
  }

  private async setSessionAlarm(session: StoredSession): Promise<void> {
    await this.state.storage.setAlarm(
      Math.min(session.expiresAt, session.idleExpiresAt, ...(await this.snapshotExpiries())),
    );
  }
}
