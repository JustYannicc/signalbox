import type { LocalIncomingMessage } from "./HttpIncomingMessage.ts";
import type { LoopbackRegistry, LoopbackListener } from "./LoopbackRegistry.ts";

export interface HttpServerHandler {
  fetch?(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}

export interface NodeStyleHttpServer {
  listen(...args: unknown[]): this;
  address(): { readonly port?: number | null };
}

export type HttpServerHandlerFactory = (server: NodeStyleHttpServer) => HttpServerHandler;

export interface ParsedRequest {
  readonly options: Record<string, unknown>;
  readonly callback: ((response: LocalIncomingMessage) => void) | undefined;
  readonly port: number;
  readonly host: string;
  readonly protocol: "http" | "https";
  readonly url: URL;
  readonly method: string;
  readonly path: string;
}

export interface LocalRequestOptions {
  readonly parsed: ParsedRequest;
  readonly binding: LoopbackListener | undefined;
  readonly registry: LoopbackRegistry;
  readonly handlerFor: HttpServerHandlerFactory;
  readonly env: unknown;
  readonly ctx: unknown;
}
