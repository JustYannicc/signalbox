// @effect-diagnostics globalDate:off globalRandom:off globalTimers:off - the Durable Object's socket boundary: plain promises and timers that live as long as one request.
import {
  DATA_KIND,
  dataFrame,
  MAX_DATA_BYTES,
  MAX_WS_MESSAGE_BYTES,
  PREVIEW_TUNNEL_VERSION,
  type PreviewPort,
  readDataFrame,
  RUNNER_STREAM_BASE,
  type TunnelThreadMessage,
  tunnelRunnerFrame,
  tunnelThreadFrame,
} from "@signalbox/runner-protocol/PreviewTunnel";
import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import type { PreviewService } from "@signalbox/runner-protocol/PreviewServices";
import type { PreviewConfiguration } from "../PreviewState.ts";
import {
  PREVIEW_SCRIPT_PATH,
  PREVIEW_VIEW_PATH,
  previewOpenPath,
  previewScript,
  startingPreview,
  withPreviewLease,
} from "./previewPage.ts";
import type { ThreadId } from "@t3tools/contracts";
import { previewLabel } from "@t3tools/shared/preview";

import { BrowserMirror, type BrowserMirrorHost } from "./BrowserMirror.ts";
import { requestHeaders, responseHeaders, sendableCloseCode } from "./previewHeaders.ts";
import {
  labelOfHost,
  PREVIEW_COOKIE,
  PREVIEW_ROUTE_COOKIE,
  previewRouteCookie,
  readPreviewRoute,
  PREVIEW_TICKET_PATH,
  previewOrigin,
  type PreviewSettings,
  readCookie,
} from "./previewHost.ts";
import { previewsLine } from "../threadWire.ts";
import {
  type PreviewClaims,
  previewToken,
  previewTokenTarget,
  verifyPreviewToken,
} from "./previewToken.ts";

/**
 * The thread object's half of the PreviewGateway: the Runner's tunnel socket
 * (`@signalbox/runner-protocol/PreviewTunnel`), and every preview request the
 * Worker routes here by host. A request is served only when
 *
 * - its credential was signed by this thread,
 * - its user can see the thread, and
 * - the machine reports a web server on the port.
 *
 * HTTP streams through the tunnel and back. A WebSocket (Vite's HMR) is
 * accepted on the hibernation API and relayed message by message; while one is
 * open the preview holds the machine's lease (`ThreadRunner.PreviewHold`).
 * Sockets survive hibernation with what they need in their attachments; HTTP
 * requests keep the object in memory until they finish.
 *
 * The agent's browser rides the same tunnel (`BrowserMirror.ts`); its
 * mirrors never hold the lease.
 */

const TUNNEL_TAG = "preview-tunnel";
const CLIENT_TAG = "preview-client";
const VIEW_TAG = "preview-view";

/** How long a link opens the preview. */
const TICKET_TTL_MS = 2 * 60_000;
/** Browser credentials outlive machines; membership is checked again on every request. */
const SESSION_TTL_MS = 12 * 60 * 60_000;
/** How long the machine has to answer a request or a WebSocket handshake. */
const HEAD_TIMEOUT_MS = 60_000;

/**
 * Close codes, ours in the 4000s. The Runner reconnects after any close; only
 * a `refused` frame stops it. Browsers get `clientGone` when the machine side
 * went away (Vite then polls and reloads) and `tooBig` past the tunnel's
 * message limit.
 */
const CLOSE = {
  refused: 4001,
  replaced: 4002,
  protocol: 4003,
  released: 4004,
  tooBig: 4009,
  clientGone: 4010,
} as const;

interface TunnelAttachment {
  readonly generation: number;
  readonly ports: ReadonlyArray<PreviewPort>;
  /** The Runner mirrors its agent's browser. Absent on tunnels from before #587. */
  readonly mirror?: boolean;
}

interface ViewAttachment {
  readonly userId: string;
  readonly port: number;
}

interface ClientAttachment {
  readonly stream: number;
  readonly generation: number;
}

export interface PreviewGatewayHost extends Pick<
  BrowserMirrorHost,
  "canSee" | "storeStep" | "logError" | "viewerId"
> {
  readonly ctx: DurableObjectState;
  readonly settings: PreviewSettings | null;
  readonly threadId: () => ThreadId;
  readonly appOrigin: string;
  readonly configuration: () => Promise<PreviewConfiguration>;
  readonly saveServices: (services: ReadonlyArray<PreviewService>) => Promise<void>;
  readonly drive: () => Promise<DriveAccess | null>;
  /** For tests; the wall clock otherwise. */
  readonly now?: () => number;
  /** The lease token when `generation` holds the lease (and `token` matches, if given). */
  readonly leaseToken: (generation: number, token?: string) => Promise<string | null>;
  /** An open preview started or ended holding the lease. */
  readonly holdChanged: () => Promise<void>;
  /** Whether the thread's browser trail has a step. */
  readonly browsed: () => Promise<boolean>;
}

interface Deferred<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
}

const deferred = <A>(): Deferred<A> => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

type Pending =
  | {
      readonly kind: "http";
      readonly head: Deferred<Response>;
      /** The response body; data arriving right after `head` already has somewhere to go. */
      readonly stream: ReadableStream<Uint8Array>;
      readonly body: ReadableStreamDefaultController<Uint8Array>;
      headSent: boolean;
      readonly port: number;
      readonly method: string;
    }
  | {
      readonly kind: "ws";
      readonly opened: Deferred<{ protocol: string } | { error: string }>;
    };

export type PreviewLinkResult =
  | { readonly _tag: "ok"; readonly url: string }
  | { readonly _tag: "unavailable"; readonly message: string };

const NULL_BODY_STATUS = new Set([204, 205, 304]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const page = (status: number, message: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Signalbox preview</title>` +
      `<body style="font:15px system-ui;margin:3rem;color:#444">${message}</body>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );

const attachmentOf = <A>(socket: WebSocket): A | null =>
  (socket.deserializeAttachment() as A | null) ?? null;

const trySend = (socket: WebSocket, data: string | Uint8Array) => {
  try {
    socket.send(data);
    return true;
  } catch {
    return false;
  }
};

const tryClose = (socket: WebSocket, code: number, reason: string) => {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed.
  }
};

export class PreviewGateway {
  private readonly pending = new Map<number, Pending>();
  private configuration: PreviewConfiguration | null = null;
  private loading: Promise<PreviewConfiguration> | null = null;

  private loadConfiguration() {
    return (this.loading ??= this.host
      .configuration()
      .then((configuration) => {
        this.configuration = configuration;
        return configuration;
      })
      .catch((cause: unknown) => {
        this.loading = null;
        throw cause;
      }));
  }

  private views() {
    return this.host.ctx
      .getWebSockets(VIEW_TAG)
      .filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  private viewState(socket: WebSocket) {
    const attachment = attachmentOf<ViewAttachment>(socket);
    return attachment !== null &&
      this.tunnel()?.attachment.ports.some((entry) => entry.port === attachment.port)
      ? "ready"
      : "starting";
  }
  // The thread's own streams stay below the Runner's (`RUNNER_STREAM_BASE`).
  private nextStream = Math.floor(Math.random() * RUNNER_STREAM_BASE);
  private lastActive: number | null = null;
  private readonly listeners = new Set<(line: string) => void>();
  /** The trail has a step; read once, before the first subscriber hears it. */
  private browsed: Promise<boolean> | null = null;
  private browsedNow = false;
  /** What the lease was last told, so it hears only flips. */
  private toldHeld = false;
  /** Labels per port: the thread id never changes. */
  private readonly labels = new Map<number, Promise<string>>();
  private readonly host: PreviewGatewayHost;
  private readonly now: () => number;
  /** The agent's browser: watchers and the steps' recordings. */
  readonly mirror: BrowserMirror;

  constructor(host: PreviewGatewayHost) {
    this.host = host;
    this.now = host.now ?? Date.now;
    this.toldHeld = this.held;
    this.mirror = new BrowserMirror({
      ...host,
      storeStep: async (step, recording) => {
        await host.storeStep(step, recording);
        this.markBrowsed();
      },
      tunnel: () => {
        const tunnel = this.tunnel();
        return tunnel === null
          ? null
          : { socket: tunnel.socket, mirror: tunnel.attachment.mirror === true };
      },
      send: (socket, message) => this.send(socket, message),
      newStream: () => this.newStream(),
    });
  }

  /** Whether a browser holds a preview socket open. */
  get held(): boolean {
    return this.clients().length > 0 || this.views().length > 0;
  }

  get lastActiveAt(): number | null {
    return this.lastActive;
  }

  private async holdMaybeChanged() {
    const held = this.held;
    if (held === this.toldHeld) return;
    this.toldHeld = held;
    await this.host.holdChanged();
  }

  private label(port: number) {
    let label = this.labels.get(port);
    if (label === undefined) {
      label = previewLabel(this.host.threadId(), port);
      this.labels.set(port, label);
    }
    return label;
  }

  isTunnel(socket: WebSocket) {
    return this.host.ctx.getTags(socket).includes(TUNNEL_TAG);
  }

  isClient(socket: WebSocket) {
    const tags = this.host.ctx.getTags(socket);
    return tags.includes(CLIENT_TAG) || tags.includes(VIEW_TAG);
  }

  acceptTunnel(): Response {
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.host.ctx.acceptWebSocket(server, [TUNNEL_TAG]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The welcomed tunnel, if one is connected. One per thread: a newer hello replaces it. */
  private tunnel(): { socket: WebSocket; attachment: TunnelAttachment } | null {
    for (const socket of this.host.ctx.getWebSockets(TUNNEL_TAG)) {
      const attachment = attachmentOf<TunnelAttachment>(socket);
      if (attachment !== null && socket.readyState === WebSocket.OPEN) {
        return { socket, attachment };
      }
    }
    return null;
  }

  private clients() {
    return this.host.ctx
      .getWebSockets(CLIENT_TAG)
      .filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  async onTunnelMessage(socket: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string") {
      const tunnel = this.tunnel();
      if (
        tunnel?.socket !== socket ||
        (await this.host.leaseToken(tunnel.attachment.generation)) === null
      )
        return;
      this.onData(data);
      return;
    }
    let message;
    try {
      message = tunnelRunnerFrame.decode(data);
    } catch {
      tryClose(socket, CLOSE.protocol, "Unreadable frame.");
      return;
    }
    if (message.type === "hello") {
      const refuse = (reason: string) => {
        trySend(socket, tunnelThreadFrame.encode({ type: "refused", message: reason }));
        tryClose(socket, CLOSE.refused, reason);
      };
      if (message.version !== PREVIEW_TUNNEL_VERSION) {
        return refuse(`This thread speaks tunnel version ${PREVIEW_TUNNEL_VERSION}.`);
      }
      if (message.threadId !== this.host.threadId()) return refuse("Wrong thread.");
      if ((await this.host.leaseToken(message.generation, message.token)) === null) {
        return refuse("This machine doesn't hold the thread's lease.");
      }
      for (const other of this.host.ctx.getWebSockets(TUNNEL_TAG)) {
        if (other !== socket) tryClose(other, CLOSE.replaced, "Replaced by a newer tunnel.");
      }
      const configuration = await this.loadConfiguration();
      this.failAll("The machine reconnected.");
      socket.serializeAttachment({
        generation: message.generation,
        ports: [],
        mirror: message.mirror === true,
      } satisfies TunnelAttachment);
      trySend(
        socket,
        tunnelThreadFrame.encode({
          type: "welcome",
          services: configuration.services,
          drive: await this.host.drive(),
          ...(this.host.settings === null
            ? {}
            : { previewHostSuffix: this.host.settings.hostSuffix }),
        }),
      );
      this.mirror.connected();
      this.notify();
      await this.holdMaybeChanged();
      return;
    }
    const attachment = attachmentOf<TunnelAttachment>(socket);
    if (attachment === null) {
      tryClose(socket, CLOSE.protocol, "Say hello first.");
      return;
    }
    if (
      this.tunnel()?.socket !== socket ||
      (await this.host.leaseToken(attachment.generation)) === null
    ) {
      tryClose(socket, CLOSE.released, "This machine is no longer current.");
      return;
    }
    switch (message.type) {
      case "services": {
        await this.host.saveServices(message.services);
        const current = await this.loadConfiguration();
        this.configuration = { ...current, services: message.services };
        this.loading = Promise.resolve(this.configuration);
        this.send(socket, { type: "services.saved", services: message.services });
        this.notify();
        return;
      }
      case "ports":
        socket.serializeAttachment({ ...attachment, ports: message.ports });
        this.notify();
        return;
      case "trail.step":
        this.mirror.onTrailStep(message.stream, message.step);
        return;
      case "head": {
        const pending = this.pending.get(message.stream);
        if (pending?.kind !== "http" || pending.headSent) return;
        // A Response can only carry these; anything else would hang the request.
        if (message.status < 200 || message.status > 599) {
          this.failStream(message.stream, `The dev server answered ${message.status}.`, socket);
          return;
        }
        pending.headSent = true;
        const nullBody = NULL_BODY_STATUS.has(message.status) || pending.method === "HEAD";
        if (nullBody) {
          pending.body.close();
          this.pending.delete(message.stream);
        }
        pending.head.resolve(
          new Response(nullBody ? null : pending.stream, {
            status: message.status,
            headers: responseHeaders(message.headers, { port: pending.port }),
            // The machine sends bytes as the dev server encoded them.
            encodeBody: "manual",
          }),
        );
        return;
      }
      case "end": {
        if (await this.mirror.onEnd(message.stream)) return;
        const pending = this.pending.get(message.stream);
        if (pending?.kind === "http") {
          this.pending.delete(message.stream);
          try {
            pending.body.close();
          } catch {
            // The browser already went away.
          }
        }
        return;
      }
      case "fail":
        if (this.mirror.onFail(message.stream, message.message)) return;
        this.failStream(message.stream, message.message);
        return;
      case "ws.opened": {
        const pending = this.pending.get(message.stream);
        if (pending?.kind === "ws") pending.opened.resolve({ protocol: message.protocol });
        return;
      }
      case "ws.close": {
        const client = this.clientFor(message.stream);
        if (client !== null) tryClose(client, sendableCloseCode(message.code), message.reason);
        return;
      }
    }
  }

  async onTunnelClose(socket: WebSocket, code = 1000, reason = "") {
    // Completes the close handshake the Runner waits on before reconnecting.
    tryClose(socket, sendableCloseCode(code), reason);
    if (attachmentOf<TunnelAttachment>(socket) === null) return;
    if (this.tunnel() !== null) return; // Replaced; the hello already cleaned up.
    this.failAll("The machine went away.");
    this.mirror.disconnected();
    this.notify();
    await this.holdMaybeChanged();
  }

  /** The lease of `generation` ended: its tunnel and every browser on it go. */
  async release(generation: number) {
    // A tab can open after the release decision. Its hold belongs to the thread,
    // so it must survive this machine and request the next one.
    let ended = false;
    for (const socket of this.host.ctx.getWebSockets(TUNNEL_TAG)) {
      if (attachmentOf<TunnelAttachment>(socket)?.generation !== generation) continue;
      tryClose(socket, CLOSE.released, "This machine is no longer needed.");
      ended = true;
    }
    if (!ended) return;
    this.failAll("The machine stopped.");
    // Watchers already moved on if a newer machine said hello first.
    if (this.tunnel() === null) this.mirror.disconnected();
    this.notify();
    await this.holdMaybeChanged();
  }

  private clientFor(stream: number): WebSocket | null {
    for (const socket of this.host.ctx.getWebSockets(CLIENT_TAG)) {
      if (attachmentOf<ClientAttachment>(socket)?.stream === stream) return socket;
    }
    return null;
  }

  async onClientMessage(socket: WebSocket, data: string | ArrayBuffer) {
    if (this.host.ctx.getTags(socket).includes(VIEW_TAG)) {
      const viewer = attachmentOf<ViewAttachment>(socket);
      if (viewer === null || !(await this.host.canSee(viewer.userId))) {
        tryClose(socket, CLOSE.refused, "You cannot see this thread.");
        this.lastActive = this.now();
        await this.holdMaybeChanged();
        return;
      }
      trySend(socket, this.viewState(socket));
      return;
    }
    const attachment = attachmentOf<ClientAttachment>(socket);
    const tunnel = this.tunnel();
    if (
      attachment === null ||
      tunnel === null ||
      tunnel.attachment.generation !== attachment.generation
    ) {
      tryClose(socket, CLOSE.clientGone, "The preview's machine went away.");
      return;
    }
    const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
    if (bytes.byteLength > MAX_WS_MESSAGE_BYTES) {
      tryClose(socket, CLOSE.tooBig, "Message too big for the preview tunnel.");
      return;
    }
    const kind = typeof data === "string" ? DATA_KIND.wsText : DATA_KIND.wsBinary;
    trySend(tunnel.socket, dataFrame(attachment.stream, kind, bytes));
  }

  async onClientClose(socket: WebSocket, code = 1000, reason = "") {
    tryClose(socket, sendableCloseCode(code), reason);
    const attachment = attachmentOf<ClientAttachment>(socket);
    const tunnel = this.tunnel();
    if (
      attachment !== null &&
      tunnel !== null &&
      tunnel.attachment.generation === attachment.generation
    ) {
      this.send(tunnel.socket, {
        type: "ws.close",
        stream: attachment.stream,
        code: sendableCloseCode(code),
        reason,
      });
    }
    this.lastActive = this.now();
    await this.holdMaybeChanged();
  }

  /**
   * Answers a request to one of the thread's preview origins; null when
   * `request` isn't for a preview origin at all.
   */
  serve(request: Request): Promise<Response> | null {
    const settings = this.host.settings;
    const url = new URL(request.url);
    const label = settings === null ? null : labelOfHost(settings, url.hostname);
    return settings === null || label === null
      ? null
      : this.servePreview(request, url, settings, label);
  }

  private async servePreview(
    request: Request,
    url: URL,
    settings: PreviewSettings,
    label: string,
  ): Promise<Response> {
    const ticket = url.pathname === PREVIEW_TICKET_PATH ? url.searchParams.get("ticket") : null;
    const credential = ticket ?? readCookie(request.headers.get("cookie"), PREVIEW_COOKIE);
    const reopen = "Open it again from the thread in Signalbox.";
    const returnToApp = async () => {
      const target =
        (credential === null ? null : previewTokenTarget(credential)) ??
        readPreviewRoute(readCookie(request.headers.get("cookie"), PREVIEW_ROUTE_COOKIE));
      if (
        request.method === "GET" &&
        (request.headers.get("accept")?.includes("text/html") ||
          request.headers.get("sec-fetch-dest") === "document") &&
        target !== null &&
        target.threadId === this.host.threadId() &&
        (await this.label(target.port)) === label
      ) {
        return new Response(null, {
          status: 302,
          headers: {
            location: new URL(
              previewOpenPath(target.threadId, target.port),
              this.host.appOrigin,
            ).toString(),
            "cache-control": "no-store",
          },
        });
      }
      return page(401, `Sign in again to open this preview. ${reopen}`);
    };
    if (credential === null) return returnToApp();
    const configuration = await this.loadConfiguration();
    const claims = await verifyPreviewToken(credential, configuration.key, this.now());
    if (
      claims === null ||
      claims.t !== this.host.threadId() ||
      (await this.label(claims.p)) !== label ||
      (ticket !== null ? claims.k !== "ticket" : claims.k !== "session")
    ) {
      return returnToApp();
    }
    if (!(await this.host.canSee(claims.u))) return page(403, "You can't see this thread.");
    if (ticket !== null) return this.signIn(claims, configuration.key);
    if (url.pathname === PREVIEW_SCRIPT_PATH) return previewScript();
    if (url.pathname === PREVIEW_VIEW_PATH) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return page(426, "Open this preview in a browser.");
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      this.host.ctx.acceptWebSocket(server, [VIEW_TAG]);
      server.serializeAttachment({ userId: claims.u, port: claims.p } satisfies ViewAttachment);
      trySend(server, this.viewState(server));
      await this.holdMaybeChanged();
      return new Response(null, { status: 101, webSocket: client });
    }
    const tunnel = this.tunnel();
    const leaseToken =
      tunnel === null ? null : await this.host.leaseToken(tunnel.attachment.generation);
    if (
      tunnel === null ||
      leaseToken === null ||
      !tunnel.attachment.ports.some((entry) => entry.port === claims.p)
    ) {
      return configuration.services.some((entry) => entry.port === claims.p)
        ? startingPreview()
        : page(404, "This preview has no dev server to start. Ask the agent to start it.");
    }
    const origin = previewOrigin(settings, label);
    return request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ? this.openSocket(request, url, tunnel, claims.p, origin)
      : this.forward(request, url, tunnel, claims.p, origin);
  }

  /** Trades a link's ticket for this origin's session cookie. */
  private async signIn(claims: PreviewClaims, key: string) {
    const session = await previewToken(key, {
      ...claims,
      k: "session",
      exp: this.now() + SESSION_TTL_MS,
    });
    const secure = this.host.settings?.scheme === "https" ? "; Secure" : "";
    const headers = new Headers({ location: "/", "cache-control": "no-store" });
    headers.append(
      "set-cookie",
      `${PREVIEW_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${SESSION_TTL_MS / 1000}`,
    );
    headers.append(
      "set-cookie",
      `${PREVIEW_ROUTE_COOKIE}=${previewRouteCookie(this.host.threadId(), claims.p)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=31536000`,
    );
    return new Response(null, { status: 302, headers });
  }

  private newStream() {
    const inUse = new Set(
      this.host.ctx
        .getWebSockets(CLIENT_TAG)
        .map((socket) => attachmentOf<ClientAttachment>(socket)?.stream),
    );
    do {
      this.nextStream = (this.nextStream + 1) % RUNNER_STREAM_BASE;
    } while (
      this.pending.has(this.nextStream) ||
      inUse.has(this.nextStream) ||
      this.mirror.owns(this.nextStream)
    );
    return this.nextStream;
  }

  private send(socket: WebSocket, message: TunnelThreadMessage) {
    return trySend(socket, tunnelThreadFrame.encode(message));
  }

  private async forward(
    request: Request,
    url: URL,
    tunnel: { socket: WebSocket },
    port: number,
    origin: string,
  ): Promise<Response> {
    const stream = this.newStream();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const response = new ReadableStream<Uint8Array>({
      // Runs during construction, so `body` is set below.
      start: (c) => {
        body = c;
      },
      cancel: () => {
        if (this.pending.delete(stream)) this.send(tunnel.socket, { type: "cancel", stream });
      },
    });
    const head = deferred<Response>();
    this.pending.set(stream, {
      kind: "http",
      head,
      stream: response,
      body,
      headSent: false,
      port,
      method: request.method,
    });
    this.send(tunnel.socket, {
      type: "request",
      stream,
      port,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: requestHeaders(request.headers, { origin, port }),
    });
    void this.pumpBody(request, tunnel.socket, stream);
    const timeout = setTimeout(
      () => this.failStream(stream, "The dev server didn't answer.", tunnel.socket),
      HEAD_TIMEOUT_MS,
    );
    try {
      return withPreviewLease(await head.promise);
    } finally {
      clearTimeout(timeout);
      this.lastActive = this.now();
    }
  }

  private async pumpBody(request: Request, socket: WebSocket, stream: number) {
    if (request.body !== null) {
      const reader = request.body.getReader();
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch {
          // A broken upload must not reach the dev server as a complete one.
          this.failStream(stream, "The upload broke off.", socket);
          return;
        }
        const { done, value } = chunk;
        if (done || !this.pending.has(stream)) break;
        for (let offset = 0; offset < value.byteLength; offset += MAX_DATA_BYTES) {
          trySend(
            socket,
            dataFrame(stream, DATA_KIND.body, value.subarray(offset, offset + MAX_DATA_BYTES)),
          );
        }
      }
    }
    if (this.pending.has(stream)) this.send(socket, { type: "end", stream });
  }

  private async openSocket(
    request: Request,
    url: URL,
    tunnel: { socket: WebSocket; attachment: TunnelAttachment },
    port: number,
    origin: string,
  ): Promise<Response> {
    const stream = this.newStream();
    const opened = deferred<{ protocol: string } | { error: string }>();
    this.pending.set(stream, { kind: "ws", opened });
    this.lastActive = this.now();
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim())
      .filter((protocol) => protocol !== "");
    this.send(tunnel.socket, {
      type: "ws.open",
      stream,
      port,
      path: `${url.pathname}${url.search}`,
      headers: requestHeaders(request.headers, { origin, port }),
      protocols,
    });
    // The browser needs the dev server's subprotocol in the handshake, so wait for it.
    const timeout = setTimeout(
      () => this.failStream(stream, "The dev server didn't answer.", tunnel.socket),
      HEAD_TIMEOUT_MS,
    );
    const result = await opened.promise;
    clearTimeout(timeout);
    this.pending.delete(stream);
    if ("error" in result) return page(502, result.error);
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.host.ctx.acceptWebSocket(server, [CLIENT_TAG]);
    server.serializeAttachment({
      stream,
      generation: tunnel.attachment.generation,
    } satisfies ClientAttachment);
    await this.holdMaybeChanged();
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: result.protocol === "" ? {} : { "sec-websocket-protocol": result.protocol },
    });
  }

  private onData(data: ArrayBuffer) {
    const frame = readDataFrame(data);
    if (frame === null || this.mirror.onData(frame)) return;
    if (frame.kind === DATA_KIND.body) {
      const pending = this.pending.get(frame.stream);
      if (pending?.kind !== "http") return;
      try {
        // A view into this message's own buffer, which nothing else holds.
        pending.body.enqueue(frame.payload);
      } catch {
        // The browser went away; `cancel` told the machine.
      }
      return;
    }
    const client = this.clientFor(frame.stream);
    if (client === null) return;
    trySend(
      client,
      frame.kind === DATA_KIND.wsText ? decoder.decode(frame.payload) : frame.payload,
    );
  }

  /** Ends a stream on the thread's side; with `tunnel`, the machine is told to drop it too. */
  private failStream(stream: number, message: string, tunnel?: WebSocket) {
    const pending = this.pending.get(stream);
    this.pending.delete(stream);
    if (pending !== undefined && tunnel !== undefined) {
      this.send(tunnel, { type: "cancel", stream });
    }
    if (pending?.kind === "ws") {
      pending.opened.resolve({ error: message });
    } else if (pending?.kind === "http") {
      if (pending.headSent) {
        try {
          pending.body.error(new Error(message));
        } catch {
          // Already closed.
        }
      } else {
        pending.head.resolve(page(502, message));
      }
    }
    const client = this.clientFor(stream);
    if (client !== null) tryClose(client, CLOSE.clientGone, message);
  }

  /** Fails every open stream: the tunnel they ran on is gone. */
  private failAll(message: string) {
    // Deleting while iterating a Map is safe.
    for (const stream of this.pending.keys()) this.failStream(stream, message);
    for (const client of this.host.ctx.getWebSockets(CLIENT_TAG)) {
      tryClose(client, CLOSE.clientGone, message);
    }
  }

  /** The ports the connected machine serves. */
  ports(): ReadonlyArray<PreviewPort> {
    const ports = new Map(
      (this.configuration?.services ?? []).map((service) => [
        service.port,
        { port: service.port, processName: null } as PreviewPort,
      ]),
    );
    for (const port of this.tunnel()?.attachment.ports ?? []) ports.set(port.port, port);
    return [...ports.values()].toSorted((a, b) => a.port - b.port);
  }

  private notify() {
    for (const view of this.views()) trySend(view, this.viewState(view));
    const line = previewsLine(this.ports(), this.browsedNow);
    for (const listener of this.listeners) listener(line);
  }

  /** The trail kept its first step: subscribers hear `browsed`. */
  private markBrowsed() {
    if (this.browsedNow) return;
    this.browsedNow = true;
    this.browsed = Promise.resolve(true);
    this.notify();
  }

  private loadBrowsed() {
    this.browsed ??= this.host.browsed().then(
      (browsed) => {
        this.browsedNow ||= browsed;
        return this.browsedNow;
      },
      (cause: unknown) => {
        // Read again by the next subscriber.
        this.browsed = null;
        this.host.logError("browser trail unreadable", cause);
        return this.browsedNow;
      },
    );
    return this.browsed;
  }

  /**
   * Newline-delimited `{ ports, browsed? }`, now and after every change;
   * null when `userId` can't see the thread.
   */
  async subscribe(userId: string): Promise<ReadableStream<Uint8Array> | null> {
    if (!(await this.host.canSee(userId))) return null;
    await this.loadConfiguration();
    await this.loadBrowsed();
    let listener: ((line: string) => void) | null = null;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        let last = "";
        listener = (line) => {
          if (line === last) return;
          last = line;
          try {
            controller.enqueue(encoder.encode(`${line}\n`));
          } catch {
            if (listener !== null) this.listeners.delete(listener);
          }
        };
        this.listeners.add(listener);
        listener(previewsLine(this.ports(), this.browsedNow));
      },
      cancel: () => {
        if (listener !== null) this.listeners.delete(listener);
      },
    });
  }

  /** A link that opens the preview of `port` for `userId`. */
  async link(userId: string, port: number, handoff = false): Promise<PreviewLinkResult> {
    const settings = this.host.settings;
    if (settings === null) return { _tag: "unavailable", message: "Previews are off here." };
    if (!(await this.host.canSee(userId))) {
      return { _tag: "unavailable", message: "Thread not found." };
    }
    const configuration = await this.loadConfiguration();
    if (!this.ports().some((entry) => entry.port === port)) {
      return { _tag: "unavailable", message: "This preview has no dev server to start." };
    }
    if (!handoff)
      return {
        _tag: "ok",
        url: new URL(previewOpenPath(this.host.threadId(), port), this.host.appOrigin).toString(),
      };
    const threadId = this.host.threadId();
    const ticket = await previewToken(configuration.key, {
      k: "ticket",
      t: threadId,
      u: userId,
      p: port,
      exp: this.now() + TICKET_TTL_MS,
    });
    const url = new URL(PREVIEW_TICKET_PATH, previewOrigin(settings, await this.label(port)));
    url.searchParams.set("ticket", ticket);
    return { _tag: "ok", url: url.toString() };
  }
}
