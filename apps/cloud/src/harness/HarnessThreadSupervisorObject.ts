import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { HarnessThreadSupervisorError } from "./HarnessThreadSupervisor.ts";
import { createHarnessThreadSupervisor } from "./HarnessThreadSupervisor.ts";
import { reserveHarnessThreadSupervisorReconciliation } from "./durableState/supervisor/service.ts";
import type { HarnessThreadSupervisorReconciliationReservation } from "./durableState/supervisor/service.ts";
import {
  claimProcessDatabaseFence,
  fencedProcessDatabase,
  readProcessFence,
  sameProcessFence,
} from "./processOwnership/fence.ts";

export class HarnessThreadSupervisorObject extends DurableObject {
  claimProcessFence(fence: unknown) {
    claimProcessDatabaseFence(this.ctx.storage, fence);
  }

  execute(command: unknown, fence?: unknown) {
    const runId = this.ctx.id.name;
    if (!runId) throw new HarnessThreadSupervisorError("INVALID");
    if (
      typeof command === "object" &&
      command !== null &&
      "type" in command &&
      command.type === "retireEvictedFacet"
    ) {
      if (
        !("currentFence" in command) ||
        fence === undefined ||
        !sameProcessFence(readProcessFence(command.currentFence), readProcessFence(fence))
      )
        throw new HarnessThreadSupervisorError("INVALID");
    }
    return Effect.runPromise(
      createHarnessThreadSupervisor(
        fencedProcessDatabase(
          this.ctx.storage,
          fence,
          typeof command === "object" &&
            command !== null &&
            "type" in command &&
            command.type === "read",
        ),
        runId,
      ).execute(command),
    );
  }

  reserveReconciliation(
    input: unknown,
    fence?: unknown,
  ): Promise<HarnessThreadSupervisorReconciliationReservation> {
    const runId = this.ctx.id.name;
    if (!runId) throw new HarnessThreadSupervisorError("INVALID");
    return Effect.runPromise(
      reserveHarnessThreadSupervisorReconciliation(
        fencedProcessDatabase(this.ctx.storage, fence),
        runId,
        input,
      ),
    );
  }
}
