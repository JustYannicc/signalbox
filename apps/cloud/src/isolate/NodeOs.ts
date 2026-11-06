import { createNodeOsWithIdentity } from "./NodeOsPersonality.ts";
import { resolveNodeProcessSystemIdentity } from "./NodeProcessSystemIdentity.ts";
import type { NodeProcessHostContext } from "./node/process/context.ts";

export function createNodeOs(
  host: Pick<NodeProcessHostContext, "env" | "identity" | "systemIdentity" | "monotonicNowNs">,
) {
  return createNodeOsWithIdentity(host, resolveNodeProcessSystemIdentity(host));
}
export default createNodeOs;
