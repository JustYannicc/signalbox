import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { HarnessThreadSupervisorError } from "./HarnessThreadSupervisor.ts";
import { createHarnessThreadSupervisor } from "./HarnessThreadSupervisor.ts";
import { reserveHarnessThreadSupervisorReconciliation } from "./durableState/supervisor/service.ts";
import type { HarnessThreadSupervisorReconciliationReservation } from "./durableState/supervisor/service.ts";

export class HarnessThreadSupervisorObject extends DurableObject {
  execute(command: unknown) {
    const runId = this.ctx.id.name;
    if (!runId) throw new HarnessThreadSupervisorError("INVALID");
    return Effect.runPromise(
      createHarnessThreadSupervisor(this.ctx.storage, runId).execute(command),
    );
  }

  reserveReconciliation(input: unknown): Promise<HarnessThreadSupervisorReconciliationReservation> {
    const runId = this.ctx.id.name;
    if (!runId) throw new HarnessThreadSupervisorError("INVALID");
    return Effect.runPromise(
      reserveHarnessThreadSupervisorReconciliation(this.ctx.storage, runId, input),
    );
  }
}
