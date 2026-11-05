import type { ClaudeAdapterV2Options } from "@signalbox/provider-claude/ClaudeAdapter";
import {
  makeClaudeIsolateAdapter,
  type ClaudeIsolateAdapterOptions,
} from "./ClaudeIsolateAdapter.ts";
import type { NativeHostBinding } from "./HarnessSessionHost.ts";
import { makeClaudeNativeBinding } from "./claude/NativeBinding.ts";

export interface ClaudeNativeHostBindingOptions extends Omit<
  ClaudeIsolateAdapterOptions,
  "adapter" | "nativeMcp"
> {
  readonly adapter: Omit<ClaudeAdapterV2Options, "queryRunner" | "environment" | "initialSnapshot">;
  readonly mcp: {
    readonly origin: string;
    readonly fetch: (request: Request) => Promise<Response>;
  };
}

/** Local embedding entry. Product Workers use the SDK host process capability. */
export function makeClaudeNativeHostBinding(
  options: ClaudeNativeHostBindingOptions,
): NativeHostBinding {
  const { mcp, ...input } = options;
  return makeClaudeNativeBinding(
    (nativeMcp) => makeClaudeIsolateAdapter({ ...input, nativeMcp }),
    mcp,
  );
}
