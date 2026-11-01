// @effect-diagnostics nodeBuiltinImport:off - Offline assets exercise the shipping builder without launching a native runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { ProviderDriverKind } from "@t3tools/contracts";
import { dataForDriver } from "./runnerTurn.fixture.ts";
import { syntheticAssets } from "./syntheticAssets.fixture.ts";
import { syntheticBundleInput } from "./syntheticBundle.fixture.ts";
import { buildCombinedFixture } from "./buildFixture.ts";
import { decodeConfiguration } from "./fixture/configuration.schema.ts";
import { validateQualifierFacetEnvironments } from "./validateFacetEnvironments.ts";
import { deploy3QualifierEnvironmentInputs } from "../qualifierEnvironment.ts";
import { assertQualifierClaudeFacetConfiguration } from "./facetEnvironmentContract.ts";
import {
  buildClaudeFacetHostOptions,
  type ClaudeFacetEnvironment,
} from "./fixture/claudeHostOptions.ts";
import { ClaudeController } from "./fixture/claudeController.ts";
import type { QualifierExecutionContext } from "./fixture/proofContext.ts";
import type { ClaudeGatewayAccess } from "../../../src/harness/ClaudeGatewayAccess.ts";
import {
  readClaudeQualificationInputs,
  decodeClaudeFacetConfiguration,
} from "./fixture/claudeConfiguration.ts";

export async function claudeHostOptionsFixture() {
  const assets = await syntheticAssets();
  try {
    const data = await Effect.runPromise(dataForDriver(ProviderDriverKind.make("claudeAgent")));
    const input = await syntheticBundleInput(assets, data);
    const built = await buildCombinedFixture(input);
    const directory = NodePath.join(input.outputDirectory, "assets");
    const configuration = decodeConfiguration(
      JSON.parse(await NodeFSP.readFile(NodePath.join(directory, "qualifier/config.json"), "utf8")),
    );
    const planned = validateQualifierFacetEnvironments(
      deploy3QualifierEnvironmentInputs({
        RUN_ID: configuration.runId,
        WORKER_NAME: configuration.workerName,
        CONFIG_SHA256: built.configSha256,
      }),
      configuration,
    ).find((boundary) => boundary.provider === "baseline" && boundary.phase === "fresh");
    if (!planned) throw new Error("Fresh Claude environment is missing");
    const binding = {
      fetch: async (request: Request) =>
        new Response(
          await NodeFSP.readFile(
            NodePath.join(
              directory,
              new URL(request.url).pathname.slice(1).split("/").map(decodeURIComponent).join("/"),
            ),
          ),
        ),
    };
    const runtime = configuration.claude.runtime;
    const opened = await readClaudeQualificationInputs(
      decodeClaudeFacetConfiguration({ ...runtime, turnJson: runtime.turnJson.baseline }),
      binding,
    );
    const artifact = configuration.claude.expected.baseline.artifact;
    const stored = new Map<string, unknown>();
    const memory = {
      get: async <A>(key: string) => stored.get(key) as A | undefined,
      put: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
      delete: async (key: string) => stored.delete(key),
      transaction: async <A>(run: (storage: DurableObjectStorage) => Promise<A>) =>
        run(memory as unknown as DurableObjectStorage),
    };
    let sequence = 0;
    const controller = new ClaudeController(
      {
        config: async () => configuration,
        append: async (kind: string) => ({
          sequence: ++sequence,
          kind,
          payload: { id: `record-${sequence}`, bytes: 0, sha256: "a".repeat(64) },
        }),
      } as unknown as QualifierExecutionContext,
      memory as unknown as DurableObjectStorage,
    );
    await controller.begin({ variant: "baseline", requestId: "baseline-create", phase: "work" });
    let issued: ClaudeGatewayAccess | undefined;
    let override: ClaudeGatewayAccess | undefined;
    const accesses: unknown[] = [];
    const port = new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === "hostConfiguration")
            return async () => ({
              runId: configuration.runId,
              imageDigest: configuration.machineInventory.imageDigest,
            });
          if (key === "prepareClaudeIncarnation")
            return (identity: Parameters<ClaudeController["prepare"]>[0]) =>
              controller.prepare(identity);
          if (key === "claudeGatewayAccess")
            return async (identity: Parameters<ClaudeController["gatewayAccess"]>[0]) => {
              accesses.push(identity);
              issued = await controller.gatewayAccess(identity);
              return override ?? issued;
            };
          return () => {
            throw new Error(`Unexpected offline capability call: ${String(key)}`);
          };
        },
      },
    );
    const descriptor = planned.environment;
    const capabilities = Reflect.get(descriptor, "HARNESS_C_PRODUCT_CAPABILITIES");
    if (typeof capabilities !== "object" || capabilities === null)
      throw new Error("Capabilities missing");
    const environment = {
      ...descriptor,
      PROGRAM_ASSETS: binding,
      HARNESS_RESUME_RUN_STORE: port,
      HARNESS_RESUME_FILES_STORE: port,
      HARNESS_RESUME_SUPERVISOR: port,
      CLAUDE_ACCESS: port,
      CLAUDE_EXECUTOR: port,
      HARNESS_C_PRODUCT_CAPABILITIES: Object.fromEntries(
        Object.keys(capabilities).map((key) => [key, port]),
      ),
    };
    assertQualifierClaudeFacetConfiguration(environment);
    let builds = 0;
    const build = async (gateway?: ClaudeGatewayAccess) => {
      override = gateway;
      const incarnation =
        builds++ === 0 ? "real-builder-incarnation" : `real-builder-incarnation-${builds}`;
      const ctx = {
        storage: {
          sql: {
            get databaseSize() {
              return 0;
            },
          },
          transactionSync: <A>(run: () => A) => run(),
        },
        waitUntil() {},
      } as unknown as DurableObjectState;
      return Effect.runPromise(
        buildClaudeFacetHostOptions({
          env: environment as unknown as ClaudeFacetEnvironment,
          ctx,
          facetNonce: incarnation,
          selectedRelease: {
            artifact,
            release: { identity: artifact, source: opened.source, ...opened.loaderConfig },
          },
        }),
      );
    };
    return {
      build,
      get issued() {
        if (!issued) throw new Error("The builder has not requested gateway access");
        return issued;
      },
      accesses,
      dispose: assets.dispose,
      gateway: controller,
    };
  } catch (cause) {
    await assets.dispose();
    throw cause;
  }
}
