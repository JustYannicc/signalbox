import { readRpcData, withRpcStub } from "../../../../src/rpc/Resources.ts";
import { DurableObject } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type {
  HarnessCProductAccessService,
  HarnessCProductExecutorForwardInput,
} from "../../../../src/harness/HarnessCProductCapabilities.ts";
import type { HarnessContinuation } from "../../../../src/harness/HarnessContinuations.ts";
import type { QualifierEnvironment } from "./environment.ts";
import { proof } from "./environment.ts";
import { createClaudeFixtureServices } from "./claudeFixtureServices.ts";

const decodeTurn = Schema.decodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));
export class QualifierClaudeFixtures extends DurableObject<QualifierEnvironment> {
  #services: Promise<ReturnType<typeof createClaudeFixtureServices>> | undefined;
  private services() {
    return (this.#services ??= withRpcStub(proof(this.env), async (stub) =>
      readRpcData(stub.config()),
    ).then((config) =>
      createClaudeFixtureServices({
        runId: config.runId,
        threadIds: (["baseline", "hooks"] as const).map(
          (variant) => decodeTurn(config.claude.runtime.turnJson[variant][0]!).threadId,
        ),
        probe: config.claude.runtime.workload.mcpProbe,
        record: (kind, value) =>
          withRpcStub(proof(this.env), async (stub) => readRpcData(stub.append(kind, value))),
      }),
    ));
  }
  async resolveFreshAccess(
    input: Parameters<NonNullable<HarnessCProductAccessService<unknown>["resolveFreshAccess"]>>[0],
  ) {
    return (await this.services()).resolveFreshAccess!(input);
  }
  async resolveInitialAccess(
    input: Parameters<HarnessCProductAccessService<unknown>["resolveInitialAccess"]>[0],
  ) {
    return (await this.services()).resolveInitialAccess(input);
  }
  async resolveTurnAccess(
    input: Parameters<HarnessCProductAccessService<unknown>["resolveTurnAccess"]>[0],
  ) {
    return (await this.services()).resolveTurnAccess(input);
  }
  async forward(input: HarnessCProductExecutorForwardInput<unknown>) {
    return (await this.services()).forward(input);
  }
  async publishContinuation(input: HarnessContinuation) {
    return (await this.services()).publishContinuation(input);
  }
}
