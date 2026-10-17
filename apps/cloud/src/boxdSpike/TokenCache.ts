import * as Schema from "effect/Schema";

const Session = Schema.Struct({ token: Schema.String, expiresAt: Schema.Number });
const decodeSession = Schema.decodeUnknownSync(Session);

export interface TokenStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export class TokenUnavailable extends Error {
  constructor() {
    super("Boxd token exchange unavailable.");
  }
}

/** Owned by one Durable Object, including the cooldown across object eviction. */
export class TokenCache {
  private inflight: Promise<string> | undefined;

  private readonly storage: TokenStorage;
  private readonly exchange: () => Promise<{ token: string; expiresAt: number }>;
  private readonly now: () => number;

  constructor(
    storage: TokenStorage,
    exchange: () => Promise<{ token: string; expiresAt: number }>,
    now: () => number,
  ) {
    this.storage = storage;
    this.exchange = exchange;
    this.now = now;
  }

  get(): Promise<string> {
    this.inflight ??= this.resolve()
      .catch(() => {
        throw new TokenUnavailable();
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private async resolve() {
    const saved = await this.storage.get("jwt");
    if (saved !== undefined) {
      const session = decodeSession(saved);
      if (session.expiresAt > this.now() + 300_000) return session.token;
    }
    const retryAt = await this.storage.get("exchangeRetryAt");
    if (typeof retryAt === "number" && retryAt > this.now()) throw new TokenUnavailable();
    // One exchange per minute even if the upstream fails or the object is evicted.
    await this.storage.put("exchangeRetryAt", this.now() + 60_000);
    try {
      const session = decodeSession(await this.exchange());
      if (!session.token || session.expiresAt <= this.now() + 300_000) {
        throw new TokenUnavailable();
      }
      await this.storage.put("jwt", session);
      return session.token;
    } catch {
      // Exchange errors can contain request credentials or the raw upstream body.
      throw new TokenUnavailable();
    }
  }
}
