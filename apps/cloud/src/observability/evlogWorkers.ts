import { toLoggerConfig, toMiddlewareOptions } from "evlog";
import { initWorkersLogger } from "evlog/workers";

import config from "../../evlog.config.ts";

/**
 * The Effect-free half of the cloud's evlog setup, for the Workers' fetch
 * handlers (the ModelGateway has no Effect runtime). Units of work inside
 * Effect are in `Evlog.ts`.
 */

/** Which part of the cloud served a request. */
export type Route =
  | "preview"
  | "socket"
  | "runner"
  | "session"
  | "preview-cleanup"
  | "pool-link"
  | "drive"
  | "api"
  | "mcp"
  | "http"
  | "assets"
  | "model";

/** The dimensions every wide event uses the same names for (#284). Ids only. */
export interface CloudFields {
  readonly person?: { readonly id: string };
  readonly folder?: { readonly id: string };
  readonly thread?: { readonly id: string };
  readonly turn?: Record<string, unknown> & { readonly id: string };
  readonly provider?: string;
  readonly model?: string;
  readonly pool?: { readonly id: string };
  readonly drive?: { readonly id: string };
  readonly automation?: Record<string, unknown> & { readonly id: string };
  readonly executor?: Record<string, unknown>;
  readonly route?: Route;
}

/** Starts evlog in this isolate: each Worker's entry module calls it once. */
export const init = () => initWorkersLogger(toLoggerConfig(config));

/** `withEvlog`'s options, from `evlog.config.ts`. */
export const requestOptions = toMiddlewareOptions(config);
