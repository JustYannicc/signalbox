import type { OrchestrationV2Command, WsRpcGroup } from "@t3tools/contracts";
import type * as RpcGroup from "effect/rpc/RpcGroup";

/**
 * How the public API reaches one RPC or `dispatchCommand` command. The API, the
 * `signalbox` CLI and the MCP tools are all generated from these entries, so
 * choosing an entry is the only thing a new RPC needs to show up everywhere
 * (#436, #335). The maps that use these are typed as complete records over the
 * contracts' RPC group, so an RPC without an entry is a type error.
 */

export type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];
export type CommandType = OrchestrationV2Command["type"];

/** What a one-shot call to a streaming RPC answers with. */
export type StreamRead =
  /** The first item: subscriptions open with the current state. */
  | "snapshot"
  /** The last item: progress streams end with their result. */
  | "final";

export interface DerivedReach {
  readonly _tag: "derived";
  /** Reads only look (refreshing a cached view counts); MCP marks them read-only. */
  readonly access: "read" | "write";
  /** Public name, `<resource>.<verb>`. Defaults to one derived from the RPC tag. */
  readonly name?: string;
  /** One line for search results and `--help`. */
  readonly summary?: string;
  /**
   * Only a person may call it: approving, answering a secret or decision
   * gate, finishing a provider sign-in (#335 decision 4). Agents never get it.
   */
  readonly humanOnly?: boolean;
  /** Deletes something. Agents need a decision gate first (#335 decision 5). */
  readonly destructive?: boolean;
  /** Streams only. Defaults to `snapshot` for reads and `final` for writes. */
  readonly stream?: StreamRead;
}

export type ExemptKind =
  /** Only means something inside one client: an editor on its host, an MCP app iframe, a push token. */
  | "client-local"
  /** A client telling the server about itself; nobody calls it on purpose. */
  | "client-report"
  /** Dispatched by the server, a runner or an agent's own machinery, never by a person. */
  | "internal";

export interface ExemptReach {
  readonly _tag: "exempt";
  readonly kind: ExemptKind;
  readonly reason: string;
}

/** `dispatchCommand` only: each client-dispatchable command is its own operation. */
export interface PerCommandReach {
  readonly _tag: "per-command";
}

export type Reach = DerivedReach | ExemptReach | PerCommandReach;

type DerivedOptions = Omit<DerivedReach, "_tag" | "access">;

export const read = (options: DerivedOptions = {}): DerivedReach => ({
  _tag: "derived",
  access: "read",
  ...options,
});

export const write = (options: DerivedOptions = {}): DerivedReach => ({
  _tag: "derived",
  access: "write",
  ...options,
});

export const exempt = (kind: ExemptKind, reason: string): ExemptReach => ({
  _tag: "exempt",
  kind,
  reason,
});

export const perCommand: PerCommandReach = { _tag: "per-command" };
