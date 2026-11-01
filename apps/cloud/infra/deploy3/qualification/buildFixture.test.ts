import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderDriverKind } from "@t3tools/contracts";
import { dataForDriver } from "./runnerTurn.fixture.ts";
import { buildCombinedFixture } from "./buildFixture.ts";
import { decodeCombinedFixtureInput } from "./bundleInput.ts";
import { fixtureHash, syntheticAssets } from "./syntheticAssets.fixture.ts";
import { syntheticBundleInput } from "./syntheticBundle.fixture.ts";
import { validateQualifierFacetEnvironments } from "./validateFacetEnvironments.ts";
import { deploy3QualifierEnvironmentInputs } from "../qualifierEnvironment.ts";
import { decodeConfiguration } from "./fixture/configuration.schema.ts";
import { validateDeploy3Plan } from "../deploymentPlan.ts";
import { validateDeploy3PlanAssets } from "../validatePlanAssets.ts";
import {
  assertQualifierClaudeFacetConfiguration,
  assertQualifierCodexFacetConfiguration,
} from "./facetEnvironmentContract.ts";
import { HARNESS_C_PRODUCT_CAPABILITY_KEYS as Keys } from "../../../src/harness/HarnessCProductCapabilities.ts";

const capabilityMap = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const runtimePort = (missing?: string) =>
  new Proxy(
    {},
    {
      get: (_target, method) =>
        method === missing
          ? undefined
          : () => {
              throw new Error("Environment validation must not invoke an RPC");
            },
    },
  );
const rejectsEnvironment = (validate: () => unknown) => {
  try {
    validate();
    return false;
  } catch {
    return true;
  }
};

it.effect(
  "combined bundle contains both product facets and pins their compiled source",
  () =>
    Effect.gen(function* () {
      const data = yield* dataForDriver(ProviderDriverKind.make("claudeAgent"));
      yield* Effect.promise(async () => {
        const f = await syntheticAssets();
        try {
          const base = await syntheticBundleInput(f, data);
          const command = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
          const commandPath = NodePath.join(f.root, "command.wasm");
          await NodeFSP.writeFile(commandPath, command);
          const commandHash = fixtureHash(command);
          const configuration = JSON.parse(
            await NodeFSP.readFile(base.codex.configuration.path, "utf8"),
          );
          configuration.commandRegistryHashes = [commandHash];
          const configurationBytes = Buffer.from(JSON.stringify(configuration));
          await NodeFSP.writeFile(base.codex.configuration.path, configurationBytes);
          const input = decodeCombinedFixtureInput({
            ...base,
            codex: {
              ...base.codex,
              configuration: {
                path: base.codex.configuration.path,
                bytes: configurationBytes.length,
                sha256: fixtureHash(configurationBytes),
              },
              commands: [{ path: commandPath, bytes: command.length, sha256: commandHash }],
            },
          });
          const result = await buildCombinedFixture(input);
          expect(result.classification).toBe("synthetic");
          expect(result.nativeStarted).toBe(false);
          expect(result.qualification).toBe("not-run");
          expect(result.deploymentReady).toBe(false);
          expect(result.fixtureBindings.namespace).toMatchObject({
            binding: "CLAUDE_FIXTURES",
            className: "QualifierClaudeFixtures",
          });
          expect(result.fixtureBindings.mcp.realExecutor).toBe(false);
          expect(result.fixtureBindings.model.networkModel).toBe(false);
          expect(result.outputs.map((pin) => pin.path)).toEqual([
            "qualifier-implementation.mjs",
            "qualifier-claude-implementation.mjs",
            "qualifier-worker.mjs",
            "qualifier-claude-workflow.mjs",
          ]);
          for (const pin of result.outputs) {
            const bytes = await NodeFSP.readFile(NodePath.join(input.outputDirectory, pin.path));
            expect(fixtureHash(bytes)).toBe(pin.sha256);
          }
          const workerOutputs = Object.values(result.metafiles["qualifier-worker"]!.outputs);
          expect(
            workerOutputs
              .flatMap((output) => output.imports)
              .filter((module) => module.path.endsWith(".wasm")),
          ).toEqual([]);
          for (const pin of input.codex.commands) {
            const bytes = await NodeFSP.readFile(
              NodePath.join(
                input.outputDirectory,
                "assets/qualifier/commands",
                `${pin.sha256}.wasm`,
              ),
            );
            expect(bytes.byteLength).toBe(pin.bytes);
            expect(fixtureHash(bytes)).toBe(pin.sha256);
          }
          const config = JSON.parse(
            await NodeFSP.readFile(
              NodePath.join(input.outputDirectory, "assets/qualifier/config.json"),
              "utf8",
            ),
          );
          const configurationHash = fixtureHash(
            await NodeFSP.readFile(
              NodePath.join(input.outputDirectory, "assets/qualifier/config.json"),
            ),
          );
          const environment = deploy3QualifierEnvironmentInputs({
            RUN_ID: config.runId,
            WORKER_NAME: config.workerName,
            CONFIG_SHA256: configurationHash,
          });
          const boundaries = validateQualifierFacetEnvironments(
            environment,
            decodeConfiguration(config),
          );
          expect(boundaries.map(({ provider, phase }) => `${provider}/${phase}`)).toEqual([
            "baseline/fresh",
            "baseline/restored",
            "hooks/fresh",
            "hooks/restored",
            "codex/fresh",
            "codex/restored",
          ]);
          const acceptedInvalidEnvironments = [];
          for (const boundary of boundaries) {
            if (boundary.provider === "codex") {
              expect(boundary.environment).toMatchObject({
                QUALIFIER_CONFIGURATION: { runId: config.runId, workerName: config.workerName },
              });
              expect(boundary.environment).not.toHaveProperty(
                "QUALIFIER_CLAUDE_PROCESS_ENVIRONMENT",
              );
            } else {
              expect(boundary.environment).toMatchObject({
                RUN_ID: config.runId,
                CONFIG_SHA256: configurationHash,
                QUALIFIER_CLAUDE_VARIANT: boundary.provider,
                QUALIFIER_CLAUDE_PROCESS_ENVIRONMENT: {
                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                  DISABLE_TELEMETRY: "1",
                  DISABLE_AUTOUPDATER: "1",
                  DISABLE_ERROR_REPORTING: "1",
                  API_TIMEOUT_MS: "5460000",
                  CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: "5460000",
                  HTTP_PROXY: "",
                  HTTPS_PROXY: "",
                  ALL_PROXY: "",
                  http_proxy: "",
                  https_proxy: "",
                  all_proxy: "",
                  NO_PROXY: "*",
                  no_proxy: "*",
                },
              });
            }
            const capabilities = capabilityMap(boundary.environment.HARNESS_C_PRODUCT_CAPABILITIES);
            const runtime = {
              ...boundary.environment,
              PROGRAM_ASSETS: runtimePort(),
              HARNESS_RESUME_RUN_STORE: runtimePort(),
              HARNESS_RESUME_FILES_STORE: runtimePort(),
              HARNESS_RESUME_SUPERVISOR: runtimePort(),
              CLAUDE_ACCESS: runtimePort(),
              CLAUDE_EXECUTOR: runtimePort(),
              HARNESS_C_PRODUCT_CAPABILITIES: Object.fromEntries(
                Object.keys(capabilities).map((key) => [key, runtimePort()]),
              ),
            };
            const validate =
              boundary.provider === "codex"
                ? assertQualifierCodexFacetConfiguration
                : assertQualifierClaudeFacetConfiguration;
            expect(() => validate(runtime)).not.toThrow();
            if (boundary.provider !== "codex") {
              const processEnvironment =
                assertQualifierClaudeFacetConfiguration(
                  runtime,
                ).QUALIFIER_CLAUDE_PROCESS_ENVIRONMENT;
              for (const key of Object.keys(processEnvironment)) {
                const missing = Object.fromEntries(
                  Object.entries(processEnvironment).filter(([name]) => name !== key),
                );
                expect(() =>
                  validate({ ...runtime, QUALIFIER_CLAUDE_PROCESS_ENVIRONMENT: missing }),
                ).toThrow(key);
              }
              for (const key of [
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_BASE_URL",
                "HOME",
                "CLAUDE_CONFIG_DIR",
              ]) {
                expect(() =>
                  validate({
                    ...runtime,
                    QUALIFIER_CLAUDE_PROCESS_ENVIRONMENT: {
                      ...processEnvironment,
                      [key]: "unexpected-override",
                    },
                  }),
                ).toThrow(key);
              }
            }
            const requiredPhaseInput =
              boundary.phase === "restored"
                ? "HARNESS_RESUME_PUBLISHER"
                : "HARNESS_RESUME_CREATION";
            const missingPhaseInput = Object.fromEntries(
              Object.entries(runtime).filter(([key]) => key !== requiredPhaseInput),
            );
            if (!rejectsEnvironment(() => validate(missingPhaseInput)))
              acceptedInvalidEnvironments.push(
                `${boundary.provider}/${boundary.phase}/${requiredPhaseInput}`,
              );
            const releaseMethods = [
              "setCheckpointParent",
              "stageCheckpoint",
              "activeCheckpointId",
              "read",
              "artifact",
              "recordRunnerEvent",
              "verifyFiles",
              "verifyArtifact",
              "recordRaw",
              ...(boundary.provider === "codex"
                ? ["prepareModelIncarnation", "seedCheckpoint"]
                : [
                    "prepareClaudeIncarnation",
                    "recordClaudeLoadedRelease",
                    "catalog",
                    "inventory",
                  ]),
            ];
            for (const [key, method] of [
              [Keys.access, "resolveFreshAccess"],
              ...releaseMethods.map((method) => [Keys.release, method]),
            ]) {
              if (
                !rejectsEnvironment(() =>
                  validate({
                    ...runtime,
                    HARNESS_C_PRODUCT_CAPABILITIES: {
                      ...runtime.HARNESS_C_PRODUCT_CAPABILITIES,
                      [key!]: runtimePort(method),
                    },
                  }),
                )
              )
                acceptedInvalidEnvironments.push(
                  `${boundary.provider}/${boundary.phase}/${method}`,
                );
            }
          }
          expect(acceptedInvalidEnvironments).toEqual([]);
          for (const key of [
            "RUN_ID",
            "CONFIG_SHA256",
            "PROGRAM_ASSETS",
            "QUALIFIER_COMMANDS",
            "CLAUDE_FIXTURES",
          ]) {
            expect(() =>
              validateQualifierFacetEnvironments(
                { ...environment, [key]: undefined },
                decodeConfiguration(config),
              ),
            ).toThrow(key);
          }
          const stage = config.runId.slice(0, 8);
          const deployment = validateDeploy3Plan(
            {
              runId: stage,
              owners: ["1070"],
              startedAtUtc: "2026-10-30T00:00:00.000Z",
              main: NodePath.join(input.outputDirectory, "qualifier-worker.mjs"),
              assetsDirectory: NodePath.join(input.outputDirectory, "assets"),
              compatibilityDate: "2026-10-19",
              compatibilityFlags: ["nodejs_compat"],
              vars: {
                RUN_ID: config.runId,
                WORKER_NAME: config.workerName,
                CONFIG_SHA256: configurationHash,
                BUNDLE_SHA256: fixtureHash(
                  await NodeFSP.readFile(
                    NodePath.join(input.outputDirectory, "qualifier-worker.mjs"),
                  ),
                ),
              },
            },
            stage,
          );
          await expect(validateDeploy3PlanAssets(deployment)).resolves.toHaveLength(6);
          await expect(
            validateDeploy3PlanAssets({
              ...deployment,
              environment: { ...deployment.environment, CONFIG_SHA256: "a".repeat(64) },
            }),
          ).rejects.toThrow("PLAN_CONFIGURATION_HASH_MISMATCH");
          expect(config.claude.runtime.assets.assets.purpose).toBe("qualification");
          expect(config.claude.runtime.seed).toEqual({
            home: "/workspace/.home/claude",
            cwd: "/workspace",
          });
          expect(config.claude.runtime.seed).not.toHaveProperty("checkpoints");
          expect(config.claude.expected.baseline.artifact.releaseId).toBe("baseline");
          expect(config.claude.expected.hooks.artifact.releaseId).toBe("hooks");
          expect(
            Object.keys(result.sources).some((path) =>
              path.endsWith("ProductClaudeHarnessSessionHost.ts"),
            ),
          ).toBe(true);
          expect(
            Object.keys(result.sources).some((path) =>
              path.endsWith("ProductCodexHarnessSessionHost.ts"),
            ),
          ).toBe(true);
          const evidenceFiles = [
            "build.json",
            ...Object.keys(result.metafiles).map((name) => `${name}.metafile.json`),
          ];
          for (const file of evidenceFiles) {
            const text = await NodeFSP.readFile(NodePath.join(input.outputDirectory, file), "utf8");
            expect(text).not.toContain(f.root);
            expect(text).not.toContain("/Users/");
            expect(text).not.toContain(".pnpm-store");
            expect(text).not.toContain("../");
          }
          expect(
            Object.keys(result.sources).every(
              (path) => path.startsWith("repo/") || path.startsWith("dependency/"),
            ),
          ).toBe(true);
          expect(result.input.codex.engine).toEqual({
            bytes: input.codex.engine.bytes,
            sha256: input.codex.engine.sha256,
          });
        } finally {
          await f.dispose();
        }
      });
    }),
  30_000,
);

it.effect("changed engine or qualification purpose is refused before an output is created", () =>
  Effect.gen(function* () {
    const data = yield* dataForDriver(ProviderDriverKind.make("claudeAgent"));
    yield* Effect.promise(async () => {
      const f = await syntheticAssets();
      try {
        const input = await syntheticBundleInput(f, data);
        await expect(
          buildCombinedFixture({
            ...input,
            claude: { ...input.claude, assets: { ...input.claude.assets, purpose: "release" } },
          }),
        ).rejects.toThrow("QUALIFICATION_ASSETS_REQUIRED");
        const changed = structuredClone(input);
        changed.codex.engine.sha256 = "e".repeat(64);
        await expect(buildCombinedFixture(changed)).rejects.toThrow("ENGINE_IDENTITY_MISMATCH");
        const wrongPrompt = structuredClone(input);
        const unexpected = JSON.parse(wrongPrompt.claudeRuntime.turnJson.baseline[1]!);
        unexpected.message.text = "Another workload";
        wrongPrompt.claudeRuntime.turnJson.baseline[1] = JSON.stringify(unexpected);
        await expect(buildCombinedFixture(wrongPrompt)).rejects.toThrow("TURN_IDENTITY_MISMATCH");
        const seeded = structuredClone(input);
        const seededTurn = JSON.parse(seeded.claudeRuntime.turnJson.baseline[0]!);
        seededTurn.providerThread.nativeThreadRef = {
          driver: "claudeAgent",
          nativeId: "11111111-1111-4111-8111-111111111111",
          strength: "strong",
        };
        seeded.claudeRuntime.turnJson.baseline[0] = JSON.stringify(seededTurn);
        await expect(buildCombinedFixture(seeded)).rejects.toThrow("TURN_IDENTITY_MISMATCH");
        const remoteProbe = structuredClone(input);
        remoteProbe.claudeRuntime.mcpProbe.toolName = "mcp__executor__real_service";
        await expect(buildCombinedFixture(remoteProbe)).rejects.toThrow(
          "LOCAL_ECHO_PROBE_REQUIRED",
        );
        const duplicate = structuredClone(input);
        const repeated = JSON.parse(duplicate.claudeRuntime.turnJson.baseline[1]!);
        repeated.runId = JSON.parse(duplicate.claudeRuntime.turnJson.baseline[0]!).runId;
        duplicate.claudeRuntime.turnJson.baseline[1] = JSON.stringify(repeated);
        await expect(buildCombinedFixture(duplicate)).rejects.toThrow("TURN_IDENTITY_REUSED");
        await expect(NodeFSP.stat(input.outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await f.dispose();
      }
    });
  }),
);
