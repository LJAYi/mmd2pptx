import type { CollectionPage, InstallationItem, StoredSession } from "./contracts";
import {
  constantTimeEqual,
  isPkceVerifier,
  randomToken,
  sha256Base64Url,
} from "./crypto";

const transactionTtlMs = 5 * 60 * 1000;
const snapshotTtlMs = 5 * 60 * 1000;
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
        ...input,
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
      const snapshot = await this.state.storage.get<InstallationSnapshot>("installationSnapshot");
      await this.state.storage.setAlarm(
        Math.min(
          session.expiresAt,
          session.idleExpiresAt,
          snapshot?.expiresAt ?? Number.POSITIVE_INFINITY,
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
        session.refreshLease = { id: lease, expiresAt: now + 30_000 };
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

    return json({ code: "NOT_FOUND" }, 404);
  }

  async alarm(): Promise<void> {
    const session = await this.state.storage.get<StoredSession>("session");
    const now = Date.now();
    if (!session || session.expiresAt <= now || session.idleExpiresAt <= now) {
      await this.state.storage.deleteAll();
      return;
    }
    const snapshot = await this.state.storage.get<InstallationSnapshot>("installationSnapshot");
    if (snapshot && snapshot.expiresAt <= now) {
      const pages = await this.state.storage.list({ prefix: "installationPage:" });
      if (pages.size > 0) await this.state.storage.delete([...pages.keys()]);
      await this.state.storage.delete("installationSnapshot");
    }
    const activeSnapshot = snapshot && snapshot.expiresAt > now ? snapshot : null;
    await this.state.storage.setAlarm(
      Math.min(
        session.expiresAt,
        session.idleExpiresAt,
        activeSnapshot?.expiresAt ?? Number.POSITIVE_INFINITY,
      ),
    );
  }

  private async activeSession(touch: boolean): Promise<StoredSession | null> {
    const session = await this.state.storage.get<StoredSession>("session");
    const now = Date.now();
    if (!session || session.expiresAt <= now || session.idleExpiresAt <= now) {
      if (session) await this.state.storage.deleteAll();
      return null;
    }
    if (touch) {
      session.idleExpiresAt = Math.min(session.expiresAt, now + 30 * 60 * 1000);
      await this.state.storage.put("session", session);
      const snapshot = await this.state.storage.get<InstallationSnapshot>("installationSnapshot");
      await this.state.storage.setAlarm(
        Math.min(
          session.expiresAt,
          session.idleExpiresAt,
          snapshot?.expiresAt ?? Number.POSITIVE_INFINITY,
        ),
      );
    }
    return session;
  }

  private page(
    snapshot: InstallationSnapshot,
    offset: number,
    items: InstallationItem[],
  ): CollectionPage<InstallationItem> {
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < snapshot.length;
    const cursor = hasMore ? randomToken() : null;
    if (cursor) snapshot.cursors[cursor] = nextOffset;
    return { items, next_cursor: cursor, has_more: hasMore };
  }

  private snapshotPageKey(snapshotId: string, offset: number): string {
    return `installationPage:${snapshotId}:${offset}`;
  }
}
