import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const cloudOnly = () =>
  Effect.fail(
    new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Use this environment's t3_thread_* and delegate_task tools. This RPC addresses cloud threads.",
    }),
  );

export const signalboxCollaborationWsHandlers = {
  "signalbox.collaboration.capabilities": cloudOnly,
  "signalbox.collaboration.list": cloudOnly,
  "signalbox.collaboration.read": cloudOnly,
  "signalbox.collaboration.send": cloudOnly,
  "signalbox.collaboration.wait": cloudOnly,
  "signalbox.collaboration.delegate": cloudOnly,
  "signalbox.collaboration.status": cloudOnly,
  "signalbox.collaboration.cancel": cloudOnly,
  "signalbox.collaboration.interrupt": cloudOnly,
};
