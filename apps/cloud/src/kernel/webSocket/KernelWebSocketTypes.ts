import type { KernelWebSocketHeader } from "./KernelWebSocketWire.ts";

export type KernelWebSocketWebSocket = WebSocket;

export interface KernelWebSocketRouteRequest {
  /** A local Request for the validated ws:// URL; no network request is made by the host. */
  readonly request: Request;
  /** Original header pairs, preserving duplicates and raw byte values as Latin-1 strings. */
  readonly headers: readonly KernelWebSocketHeader[];
  /** Canonical URL authority for the request-scoped router's exact allowlist check. */
  readonly authority: string;
  readonly signal: AbortSignal;
}

export interface KernelWebSocketRouteResponse {
  readonly status: number;
  readonly headers: readonly KernelWebSocketHeader[];
  readonly body?: Uint8Array;
  /** A 101 response must carry an accepted server-side socket. */
  readonly webSocket?: KernelWebSocketWebSocket | null;
}

/** Response body/socket from the loopback adapter plus lossless raw header pairs. */
export interface KernelWebSocketResponseWithHeaders {
  /** The adapter accepts its in-process upgrade socket before returning this wrapper. */
  readonly response: Response;
  readonly headers: readonly KernelWebSocketHeader[];
}

export type KernelWebSocketRouteResult =
  | KernelWebSocketRouteResponse
  | KernelWebSocketResponseWithHeaders;

export type KernelWebSocketRoute = (
  input: KernelWebSocketRouteRequest,
) => KernelWebSocketRouteResult | Promise<KernelWebSocketRouteResult>;
