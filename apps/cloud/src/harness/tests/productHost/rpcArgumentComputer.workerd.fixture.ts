import { ComputerExecutionObject as Base } from "../../../computer/ComputerExecutionObject.ts";
import { rpcResourceSnapshot } from "../../../rpc/Resources.ts";
import type { ProcessSlotState } from "../../../computer/ProcessSlots.ts";
export class ComputerExecutionObject extends Base {
  async resources() {
    const slots = await this.ctx.storage.list<ProcessSlotState>({
      prefix: "child-worker-slots-v1:",
    });
    const states = [...slots.values()];
    return {
      ...rpcResourceSnapshot(),
      processSlots: {
        stores: states.length,
        holders: states.flatMap((state) => state.slots).filter((slot) => slot.holder !== undefined)
          .length,
        lost: states.reduce((sum, state) => sum + state.lost, 0),
      },
    };
  }
}
