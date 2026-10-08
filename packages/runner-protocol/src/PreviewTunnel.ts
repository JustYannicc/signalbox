import { NonNegativeInt, PositiveInt, ThreadId } from "@t3tools/contracts";
import { SignalboxPreviewPort } from "@t3tools/contracts/signalboxPreviews";
import * as Schema from "effect/Schema";

import { frameCodec } from "./RunnerProtocol.ts";

/**
 * The PreviewGateway's tunnel: a second outbound WebSocket from a thread's
 * Runner to its Durable Object, carrying HTTP requests and WebSockets to the
 * dev servers on the machine. The machine takes no inbound connections, so
 * the gateway reaches its ports only through here.
 *
 * 1. The Runner says `hello` with the same generation and token as its main
 *    socket. The thread `welcome`s only the machine holding the lease, so a
 *    stale machine can't serve; a newer generation closes the tunnel.
 * 2. The Runner reports the web servers listening on the machine (`ports`)
 *    whenever they change. Only those ports are reachable.
 * 3. The thread opens streams: `request` (HTTP) or `ws.open` (a WebSocket,
 *    e.g. Vite's HMR). Each stream has a number the thread picks. Bodies and
 *    WebSocket messages travel as binary data frames (`dataFrame`); control
 *    frames are JSON text.
 * 4. HTTP: the thread sends the request body as data then `end`; the Runner
 *    answers `head`, the body as data, then `end`, or `fail` at any point.
 *    WebSocket: the Runner answers `ws.opened` or `fail`; then messages flow
 *    both ways as data until either side sends `ws.close`. `cancel` drops a
 *    stream the thread no longer wants.
 *
 * The heartbeat is the Runner protocol's (`ping`/`pong`).
 */

export const PREVIEW_TUNNEL_VERSION = 1;

/** Where a Runner opens its tunnel, with `?threadId=`. The token travels in `hello`, never the URL. */
export const PREVIEW_TUNNEL_PATH = "/api/runner/preview";

/** Request and response headers, in order, repeats allowed. */
const Headers = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));

/** A web server on the machine: what clients list, as they list it. */
export const PreviewPort = SignalboxPreviewPort;
export type PreviewPort = SignalboxPreviewPort;

const Stream = NonNegativeInt;

/** Runner to thread. */
export const TunnelRunnerMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("hello"),
    version: PositiveInt,
    threadId: ThreadId,
    generation: PositiveInt,
    token: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("ports"), ports: Schema.Array(PreviewPort) }),
  Schema.Struct({
    type: Schema.Literal("head"),
    stream: Stream,
    status: PositiveInt,
    headers: Headers,
  }),
  /** The response body is complete. */
  Schema.Struct({ type: Schema.Literal("end"), stream: Stream }),
  /** The stream broke, or never reached the port. */
  Schema.Struct({ type: Schema.Literal("fail"), stream: Stream, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("ws.opened"), stream: Stream, protocol: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("ws.close"),
    stream: Stream,
    code: Schema.Number,
    reason: Schema.String,
  }),
]);
export type TunnelRunnerMessage = typeof TunnelRunnerMessage.Type;

/** Thread to Runner. */
export const TunnelThreadMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("welcome") }),
  Schema.Struct({ type: Schema.Literal("refused"), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("request"),
    stream: Stream,
    port: PositiveInt,
    method: Schema.String,
    /** Path and query, e.g. `/src/main.ts?t=1`. */
    path: Schema.String,
    headers: Headers,
  }),
  /** The request body is complete. */
  Schema.Struct({ type: Schema.Literal("end"), stream: Stream }),
  Schema.Struct({ type: Schema.Literal("cancel"), stream: Stream }),
  Schema.Struct({
    type: Schema.Literal("ws.open"),
    stream: Stream,
    port: PositiveInt,
    path: Schema.String,
    headers: Headers,
    protocols: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("ws.close"),
    stream: Stream,
    code: Schema.Number,
    reason: Schema.String,
  }),
]);
export type TunnelThreadMessage = typeof TunnelThreadMessage.Type;

export const tunnelRunnerFrame = frameCodec(TunnelRunnerMessage);
export const tunnelThreadFrame = frameCodec(TunnelThreadMessage);

/**
 * Per-connection headers neither side forwards, besides any `proxy-*` header
 * and any the `connection` header names (see `endToEnd`).
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** `headers` without hop-by-hop ones. Names are compared case-insensitively. */
export const endToEnd = <H extends readonly [string, string]>(headers: Iterable<H>): Array<H> => {
  const all = [...headers];
  const named = new Set(
    all
      .filter(([name]) => name.toLowerCase() === "connection")
      .flatMap(([, value]) => value.split(",").map((token) => token.trim().toLowerCase())),
  );
  return all.filter(([name]) => {
    const lower = name.toLowerCase();
    return !HOP_BY_HOP.has(lower) && !lower.startsWith("proxy-") && !named.has(lower);
  });
};

/** What a binary frame carries. */
export const DATA_KIND = { body: 0, wsText: 1, wsBinary: 2 } as const;
export type DataKind = (typeof DATA_KIND)[keyof typeof DATA_KIND];

/** Largest body payload per data frame; bodies span as many frames as they need. */
export const MAX_DATA_BYTES = 64 * 1024;

/**
 * Largest WebSocket message: one message is one data frame. Bigger ones close
 * the socket with 1009, as a server with that limit would.
 */
export const MAX_WS_MESSAGE_BYTES = 1024 * 1024;

/** A binary frame: the stream (u32, big-endian), the kind (u8), then the payload. */
export const dataFrame = (stream: number, kind: DataKind, payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(5 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, stream);
  frame[4] = kind;
  frame.set(payload, 5);
  return frame;
};

export interface DataFrame {
  readonly stream: number;
  readonly kind: DataKind;
  readonly payload: Uint8Array;
}

/** Null when `frame` isn't a data frame this version knows. */
export const readDataFrame = (frame: ArrayBuffer | Uint8Array): DataFrame | null => {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < 5) return null;
  const kind = bytes[4];
  if (kind !== DATA_KIND.body && kind !== DATA_KIND.wsText && kind !== DATA_KIND.wsBinary) {
    return null;
  }
  return {
    stream: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0),
    kind,
    payload: bytes.subarray(5),
  };
};
