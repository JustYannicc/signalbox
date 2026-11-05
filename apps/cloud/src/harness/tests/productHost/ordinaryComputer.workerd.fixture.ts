// @effect-diagnostics cryptoRandomUUID:off - The test observes real isolate identities.
import { ComputerExecutionObject as ComputerBase } from "../../../computer/ComputerExecutionObject.ts";
import { commandLoader } from "./commands.ts";
import type { OrdinaryOwnerEnvironment } from "./ordinaryOwnerObservation.fixture.ts";

let nonce: string | undefined;
const realm = () => (nonce ??= crypto.randomUUID());

export class ComputerExecutionObject extends ComputerBase {
  constructor(ctx: DurableObjectState, env: OrdinaryOwnerEnvironment) {
    const loader = commandLoader().loader;
    super(ctx, {
      RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
      CHILD_WORKERS: {
        async run(input, target) {
          await env.OBSERVE.record({ kind: input.command.executable, realm: realm() });
          return await loader.run(input, target);
        },
      },
    });
  }
}
