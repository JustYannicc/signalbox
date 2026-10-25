import type { KernelWebSocketHeader } from "./KernelWebSocketWire.ts";

export type KernelWebSocketWebSocket = WebSocket;

export interface KernelWebSocketRouteRequest {
  /** The validated ws/wss URL. The route owns dialing and network authority. */
  readonly request: Request;
  /** Original header pairs, preserving duplicates and raw byte values as Latin-1 strings. */
  readonly headers: readonly KernelWebSocketHeader[];
  /** Canonical URL authority for the route's destination check. */
  readonly authority: string;
  readonly signal: AbortSignal;
}

export interface KernelWebSocketRouteResponse {
  readonly status: number;
  readonly headers: readonly KernelWebSocketHeader[];
  readonly body?: Uint8Array;
  /** A 101 response must carry an accepted native socket. */
  readonly webSocket?: KernelWebSocketWebSocket | null;
}

/** Native response body/socket plus lossless raw header pairs. */
export interface KernelWebSocketResponseWithHeaders {
  /** The adapter accepts the upgrade socket before returning this wrapper. */
  readonly response: Response;
  readonly headers: readonly KernelWebSocketHeader[];
}

export type KernelWebSocketRouteResult =
  | KernelWebSocketRouteResponse
  | KernelWebSocketResponseWithHeaders;

export type KernelWebSocketRoute = (
  input: KernelWebSocketRouteRequest,
) => KernelWebSocketRouteResult | Promise<KernelWebSocketRouteResult>;
