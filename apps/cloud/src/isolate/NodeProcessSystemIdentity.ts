import * as Schema from "effect/Schema";
import {
  SystemIdentity,
  systemIdentityForThread,
  type SystemIdentity as SystemIdentityValue,
} from "@t3tools/contracts/systemIdentity";
import type { NodeProcessHostContext } from "./node/process/context.ts";

const decodeSystemIdentity = Schema.decodeUnknownSync(SystemIdentity);

export function resolveNodeProcessSystemIdentity(
  context: Pick<NodeProcessHostContext, "identity" | "systemIdentity">,
): SystemIdentityValue {
  return context.systemIdentity === undefined
    ? systemIdentityForThread("process-" + context.identity.pid)
    : decodeSystemIdentity(context.systemIdentity);
}
