import { type AuthEnvironmentScope, WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { constPing, constPong, type FromClientEncoded } from "effect/rpc/RpcMessage";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Scope from "effect/Scope";

import type * as Environment from "../environment.ts";
import { sendableCloseCode } from "../thread/preview/previewHeaders.ts";
import { type Connection, openConnection } from "./connection.ts";
import { CloudRpcGroup } from "./rpc.ts";

/**
 * The user object's end of its clients' RPC sockets. Sockets use the
 * hibernation API, so an object whose clients are only connected leaves
 * memory and isn't billed until one of them, a thread or the Worker needs it.
 * Pings are answered without waking it (`PING`).
 *
 * Effect's RPC server lives in memory, so each socket's open subscriptions
 * also live in storage: a woken object replays them into a fresh server under
 * the client's own request ids. The client keeps its streams and gets their
 * current state again, then every change after it.
 *
 * Only subscriptions served from this object's memory let it go: one that
 * reads another object (a thread's events, its previews) or polls (branch
 * status) keeps it in memory while it's open.
 */

const CLIENT_TAG = "client";
const sessionTag = (sid: string) => `session:${sid}`;
const STORED_PREFIX = "clientSocket/";

/** The client's keepalive and its answer, exactly as JSON serialization writes them. */
export const PING = JSON.stringify(constPing);
export const PONG = JSON.stringify(constPong);

interface Attachment {
  /** Names the socket's stored subscriptions. */
  readonly key: string;
  readonly sid: string;
  readonly userId: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  /** An open socket never outlives its session. */
  readonly expiresAt: number;
}

export interface ClientSession {
  readonly sid: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly expiresAt: number;
}

/** The slice of `DurableObjectState` sockets use. */
export interface ClientSocketState {
  readonly acceptWebSocket: (socket: WebSocket, tags: Array<string>) => void;
  readonly getWebSockets: (tag?: string) => Array<WebSocket>;
  readonly storage: {
    readonly kv: Pick<DurableObjectState["storage"]["kv"], "get" | "put" | "delete" | "list">;
  };
}

type ConnectionServices = Exclude<Effect.Services<ReturnType<typeof openConnection>>, Scope.Scope>;

export interface ClientSocketHost {
  readonly ctx: ClientSocketState;
  readonly identity: Environment.CloudEnvironmentIdentity;
  readonly run: <A>(
    effect: Effect.Effect<A, never, ConnectionServices | Crypto.Crypto>,
  ) => Promise<A>;
}

/**
 * RPCs that stay open to watch something: the only requests safe to run
 * again. A stacked git action streams too, but running it again would commit
 * and push again.
 */
const replayed: ReadonlySet<string> = new Set(
  [...CloudRpcGroup.requests.values()]
    .filter((rpc) => RpcSchema.isStreamSchema(rpc.successSchema))
    .map((rpc) => rpc._tag)
    .filter((tag) => tag !== WS_METHODS.gitRunStackedAction),
);

const attachmentOf = (socket: WebSocket): Attachment | null =>
  (socket.deserializeAttachment() as Attachment | null) ?? null;

const close = (socket: WebSocket, code: number, reason: string) => {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed.
  }
};

export class ClientSockets {
  /**
   * This object's servers, by socket key; empty after waking until `restore`.
   * `received` chains the socket's frames, so they reach its server in order.
   */
  private readonly live = new Map<
    string,
    {
      readonly opened: Promise<Connection>;
      readonly scope: Scope.Closeable;
      /** Ids of the requests in storage, so only their ends touch it. */
      readonly stored: Set<string>;
      received: Promise<void>;
    }
  >();

  private readonly host: ClientSocketHost;

  constructor(host: ClientSocketHost) {
    this.host = host;
  }

  private storedKey(socketKey: string, requestId: string) {
    return `${STORED_PREFIX}${socketKey}/${requestId}`;
  }

  private stored(socketKey: string): Array<FromClientEncoded> {
    return [
      ...this.host.ctx.storage.kv.list<FromClientEncoded>({
        prefix: `${STORED_PREFIX}${socketKey}/`,
      }),
    ].map(([, message]) => message);
  }

  private forget(socketKey: string) {
    const { kv } = this.host.ctx.storage;
    // Read first: deleting while listing skips entries.
    for (const [key] of Array.from(kv.list({ prefix: `${STORED_PREFIX}${socketKey}/` }))) {
      kv.delete(key);
    }
  }

  /** Serves `socket`, replaying what it had open when this object last left memory. */
  private serve(socket: WebSocket, attachment: Attachment) {
    const existing = this.live.get(attachment.key);
    if (existing) return existing;
    const { kv } = this.host.ctx.storage;
    const scope = Scope.makeUnsafe();
    const replay = this.stored(attachment.key);
    const stored = new Set(
      replay.flatMap((message) => (message._tag === "Request" ? [String(message.id)] : [])),
    );
    const unstore = (requestId: string) => {
      if (stored.delete(requestId)) kv.delete(this.storedKey(attachment.key, requestId));
    };
    const opened = this.host.run(
      openConnection({
        identity: this.host.identity,
        userId: attachment.userId,
        sid: attachment.sid,
        scopes: attachment.scopes,
        replay,
        send: (frame, message) => {
          if (message._tag === "Exit") unstore(String(message.requestId));
          try {
            socket.send(frame);
          } catch {
            // Closing; the client reconnects and subscribes again.
          }
        },
        receiving: (message) => {
          if (message._tag === "Request" && replayed.has(message.tag)) {
            stored.add(String(message.id));
            kv.put(this.storedKey(attachment.key, String(message.id)), message);
          } else if (message._tag === "Interrupt") {
            unstore(String(message.requestId));
          }
        },
      }).pipe(Scope.provide(scope)),
    );
    const live = { opened, scope, stored, received: opened.then(() => undefined) };
    this.live.set(attachment.key, live);
    return live;
  }

  /**
   * Ends the socket's server and what it stored, and closes the socket. Its
   * attachment goes too, so a frame that arrives while it closes finds no
   * session to start a server for.
   */
  private async drop(socket: WebSocket, code: number, reason: string) {
    const attachment = attachmentOf(socket);
    try {
      socket.serializeAttachment(null);
    } catch {
      // Already closed.
    }
    close(socket, code, reason);
    if (attachment === null) return;
    this.forget(attachment.key);
    const live = this.live.get(attachment.key);
    this.live.delete(attachment.key);
    if (live) await this.host.run(Scope.close(live.scope, Exit.void));
  }

  /** Accepts `socket` for an authenticated session and starts serving it. */
  async accept(socket: WebSocket, session: ClientSession, userId: string) {
    this.host.ctx.acceptWebSocket(socket, [CLIENT_TAG, sessionTag(session.sid)]);
    const attachment: Attachment = {
      key: await this.host.run(Effect.orDie(Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()))),
      sid: session.sid,
      userId,
      scopes: session.scopes,
      expiresAt: session.expiresAt,
    };
    socket.serializeAttachment(attachment);
    await this.serve(socket, attachment).opened;
  }

  /**
   * Serves every socket again after the object woke, before anything else
   * runs: a change one client or thread makes must reach every other
   * client's subscriptions. Also drops what sockets that are gone stored.
   */
  async restore(now: number) {
    const sockets = this.host.ctx.getWebSockets(CLIENT_TAG);
    const keys = new Set(sockets.map((socket) => attachmentOf(socket)?.key));
    const { kv } = this.host.ctx.storage;
    for (const [key] of Array.from(kv.list({ prefix: STORED_PREFIX }))) {
      if (!keys.has(key.slice(STORED_PREFIX.length).split("/")[0])) kv.delete(key);
    }
    for (const socket of sockets) {
      const attachment = attachmentOf(socket);
      if (attachment === null) close(socket, 1011, "Unknown socket");
      else if (attachment.expiresAt <= now) await this.drop(socket, 1000, "Session expired");
      else {
        // One socket's server failing to start mustn't keep the object from waking.
        await this.serve(socket, attachment).opened.catch(() =>
          this.drop(socket, 1011, "Connection failed"),
        );
      }
    }
  }

  async message(socket: WebSocket, frame: string | ArrayBuffer) {
    const attachment = attachmentOf(socket);
    if (attachment === null) return close(socket, 1011, "Unknown socket");
    const live = this.serve(socket, attachment);
    live.received = live.received.then(async () =>
      this.host.run((await live.opened).receive(frame)),
    );
    // A server that couldn't start serves nothing; the client reconnects to a fresh one.
    await live.received.catch(() => this.drop(socket, 1011, "Connection failed"));
  }

  async closed(socket: WebSocket, code = 1000, reason = "") {
    await this.drop(socket, sendableCloseCode(code), reason);
  }

  /** Disconnects every socket of a revoked session. */
  async revoke(sid: string) {
    for (const socket of this.host.ctx.getWebSockets(sessionTag(sid))) {
      await this.drop(socket, 1000, "Session revoked");
    }
  }

  /** Disconnects sockets whose session has expired; the next expiry, if any. */
  async expire(now: number): Promise<number | null> {
    let next: number | null = null;
    for (const socket of this.host.ctx.getWebSockets(CLIENT_TAG)) {
      const expiresAt = attachmentOf(socket)?.expiresAt;
      if (expiresAt === undefined) continue;
      if (expiresAt <= now) await this.drop(socket, 1000, "Session expired");
      else next = next === null ? expiresAt : Math.min(next, expiresAt);
    }
    return next;
  }
}
