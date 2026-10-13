// @effect-diagnostics nodeBuiltinImport:off - streams to the machine's dev servers through Node's http client and `ws`.
import * as NodeHttp from "node:http";

import { NodeWS } from "@effect/platform-node-shared/NodeSocket";
import {
  DATA_KIND,
  type DataKind,
  dataFrame,
  endToEnd,
  MAX_DATA_BYTES,
  MAX_WS_MESSAGE_BYTES,
  type TunnelRunnerMessage,
  type TunnelThreadMessage,
} from "@signalbox/runner-protocol/PreviewTunnel";

/**
 * The machine end of the PreviewGateway's streams: one HTTP request or one
 * WebSocket to a dev server on `localhost`, driven by the thread's frames and
 * answering through `emit`. Plain Node callbacks, so frames go out in the
 * order the dev server produced them.
 *
 * No backpressure beyond the 64 KiB data frames: a fast dev server can buffer
 * a response in the tunnel's outbox, and a large upload buffers in the
 * request. Fine for dev servers; revisit if previews stream large files.
 */

/** What a stream sends the thread: a control message or an encoded data frame. */
export type TunnelFrame = TunnelRunnerMessage | Uint8Array;

/** One open stream, as the tunnel drives it. */
export interface ProxyStream {
  /** A data frame the thread sent on this stream. */
  readonly data: (kind: DataKind, payload: Uint8Array) => void;
  /** The thread's `end`: the request body is complete. */
  readonly end: () => void;
  /** The thread's `ws.close`. */
  readonly close: (code: number, reason: string) => void;
  /** Drops the stream without a word to the thread: `cancel`, or the tunnel closed. */
  readonly abort: () => void;
}

export interface ProxyStreamInput {
  readonly emit: (frame: TunnelFrame) => void;
  /** Called once the stream is over, whichever side ended it. */
  readonly done: () => void;
}

type Headers = ReadonlyArray<readonly [string, string]>;
type RequestMessage = Extract<TunnelThreadMessage, { type: "request" }>;
type WsOpenMessage = Extract<TunnelThreadMessage, { type: "ws.open" }>;

const pairs = (raw: ReadonlyArray<string>): Headers => {
  const result: Array<readonly [string, string]> = [];
  for (let index = 0; index + 1 < raw.length; index += 2)
    result.push([raw[index]!, raw[index + 1]!]);
  return result;
};

const sendData = (input: ProxyStreamInput, stream: number, kind: DataKind, bytes: Uint8Array) => {
  for (let offset = 0; offset < bytes.byteLength; offset += MAX_DATA_BYTES) {
    input.emit(dataFrame(stream, kind, bytes.subarray(offset, offset + MAX_DATA_BYTES)));
  }
};

/** Why a connection failed. Family autoselection reports every address it tried. */
const describeError = (error: Error): string =>
  error instanceof AggregateError
    ? [...new Set(error.errors.map((inner: Error) => describeError(inner)))].join(", ")
    : error.message || (error as NodeJS.ErrnoException).code || error.name;

/** Ends a stream once: the last frame, if any, then `done`. */
const finisher = (input: ProxyStreamInput) => {
  let finished = false;
  return {
    get finished() {
      return finished;
    },
    finish: (frame?: TunnelFrame) => {
      if (finished) return;
      finished = true;
      if (frame !== undefined) input.emit(frame);
      input.done();
    },
  };
};

/** Proxies one HTTP request. Throws if Node rejects the request outright (e.g. a bad path). */
export const proxyHttp = (request: RequestMessage, input: ProxyStreamInput): ProxyStream => {
  const { stream, port } = request;
  const state = finisher(input);
  const fail = (message: string) => state.finish({ type: "fail", stream, message });
  const headers = endToEnd(request.headers);
  if (!headers.some(([name]) => name.toLowerCase() === "host")) {
    headers.unshift(["host", `localhost:${port}`]);
  }
  // `localhost` with family autoselection (Node passes it on to `net.connect`)
  // reaches a server bound to ::1 or 127.0.0.1 alike.
  const options: NodeHttp.RequestOptions & { readonly autoSelectFamily: boolean } = {
    host: "localhost",
    port,
    autoSelectFamily: true,
    method: request.method,
    path: request.path,
    // The browser's own accept-encoding goes through: the gateway passes the
    // body's bytes on untouched, so a compressed response reaches it as sent.
    headers: headers.flat(),
  };
  const outgoing = NodeHttp.request(options);
  outgoing.on("error", (error) => fail(`localhost:${port}: ${describeError(error)}`));
  outgoing.on("response", (response) => {
    if (state.finished) return void response.destroy();
    input.emit({
      type: "head",
      stream,
      status: response.statusCode ?? 502,
      headers: endToEnd(pairs(response.rawHeaders)),
    });
    response.on("data", (chunk: Buffer) => {
      if (!state.finished) sendData(input, stream, DATA_KIND.body, chunk);
    });
    response.on("end", () => state.finish({ type: "end", stream }));
    response.on("error", (error) => fail(`localhost:${port}: ${describeError(error)}`));
    response.on("close", () => fail(`localhost:${port} cut the response off.`));
  });
  return {
    data: (kind, payload) => {
      if (kind === DATA_KIND.body && !state.finished) outgoing.write(payload);
    },
    end: () => {
      if (!state.finished) outgoing.end();
    },
    close: () => {},
    abort: () => {
      state.finish();
      outgoing.destroy();
    },
  };
};

/** Closes `socket` with `code` when `ws` allows sending it, plainly otherwise. */
const closeSocket = (socket: NodeWS.WebSocket, code: number, reason: string) => {
  try {
    socket.close(code, reason);
  } catch {
    socket.close();
  }
};

/** Proxies one WebSocket. */
export const proxyWebSocket = (open: WsOpenMessage, input: ProxyStreamInput): ProxyStream => {
  const { stream, port } = open;
  const state = finisher(input);
  // `ws` makes its own handshake and negotiates its own extensions.
  const headers: Record<string, string> = {};
  for (const [name, value] of endToEnd(open.headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith("sec-websocket-")) continue;
    headers[lower] =
      lower in headers ? `${headers[lower]}${lower === "cookie" ? "; " : ", "}${value}` : value;
  }
  const options: NodeWS.ClientOptions & { readonly autoSelectFamily: boolean } = {
    headers,
    autoSelectFamily: true,
  };
  const socket = new NodeWS.WebSocket(
    `ws://localhost:${port}${open.path}`,
    [...open.protocols],
    options,
  );
  // The gateway accepts the browser's socket only after `ws.opened`, so the
  // thread sends nothing before then.
  let opened = false;

  socket.on("open", () => {
    if (state.finished) return;
    opened = true;
    input.emit({ type: "ws.opened", stream, protocol: socket.protocol });
  });
  socket.on("message", (data: Buffer | ArrayBuffer | Array<Buffer>, isBinary: boolean) => {
    if (state.finished) return;
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data;
    if (bytes.byteLength > MAX_WS_MESSAGE_BYTES) {
      // A message travels as one data frame, so a bigger one can't cross.
      const reason = "Message too big for the preview tunnel.";
      closeSocket(socket, 1009, reason);
      return state.finish({ type: "ws.close", stream, code: 1009, reason });
    }
    input.emit(dataFrame(stream, isBinary ? DATA_KIND.wsBinary : DATA_KIND.wsText, bytes));
  });
  socket.on("error", (error) =>
    state.finish({ type: "fail", stream, message: `localhost:${port}: ${describeError(error)}` }),
  );
  socket.on("close", (code, reason) =>
    state.finish(
      opened
        ? { type: "ws.close", stream, code, reason: reason.toString() }
        : { type: "fail", stream, message: `localhost:${port} closed the WebSocket.` },
    ),
  );

  return {
    data: (kind, payload) => {
      if (state.finished || !opened || kind === DATA_KIND.body) return;
      socket.send(payload, { binary: kind === DATA_KIND.wsBinary });
    },
    end: () => {},
    close: (code, reason) => {
      state.finish();
      closeSocket(socket, code, reason);
    },
    abort: () => {
      state.finish();
      socket.terminate();
    },
  };
};
