import { createNodeProcessWithIdentity } from "./NodeProcessPersonality.ts";
import { resolveNodeProcessSystemIdentity } from "./NodeProcessSystemIdentity.ts";
import type { NodeProcessHostContext } from "./node/process/context.ts";
export * from "./NodeProcessPersonality.ts";

export function createNodeProcess(host: NodeProcessHostContext) {
  return createNodeProcessWithIdentity(host, resolveNodeProcessSystemIdentity(host));
}
export default createNodeProcess;
