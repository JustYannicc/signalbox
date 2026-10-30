import { claudeQualificationTurns } from "./fixture/claudeTurns.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { codexFixture } from "./codexRelease.fixture.ts";
import { loadHarnessRelease } from "../../../src/harness/HarnessReleaseLoader.ts";
import { productLoadedPreparedRelease } from "../../../src/harness/ProductHarnessProcessRelease.ts";
import { fixtureHash, syntheticAssets } from "./syntheticAssets.fixture.ts";
import { syntheticConfiguration } from "./syntheticConfiguration.fixture.ts";
import type { SyntheticProviderData } from "./runnerTurn.fixture.ts";
const encodeTurn = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));

export async function syntheticBundleInput(
  f: Awaited<ReturnType<typeof syntheticAssets>>,
  data: SyntheticProviderData,
) {
  const { turn } = data;
  const seed = { home: "/workspace/.home/claude", cwd: "/workspace" };
  const turns = (variant: "baseline" | "hooks") =>
    claudeQualificationTurns(
      {
        ...turn,
        providerThread: {
          ...turn.providerThread,
          nativeThreadRef: null,
        },
      },
      variant,
    ).map((turn) => encodeTurn(turn));
  const engineBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const material = await codexFixture({ engineBytes });
  const loaded = await loadHarnessRelease(material.options);
  const artifact = {
    ...material.options.identity,
    provider: "codex" as const,
    releaseId: "synthetic-deploy3-codex",
    fixtureIdentity: "synthetic-deploy3",
    createdAt: "2026-10-30T00:00:00Z",
  };
  const expectedRelease = productLoadedPreparedRelease("codex", artifact, loaded);
  const pin = async (name: string, bytes: Uint8Array) => {
    const path = NodePath.join(f.root, name);
    await NodeFSP.writeFile(path, bytes);
    return { path, bytes: bytes.length, sha256: fixtureHash(bytes) };
  };
  return {
    schema: "signalbox/deploy3-combined-fixture/v1" as const,
    classification: "synthetic" as const,
    assetsDirectory: f.assetsDirectory,
    outputDirectory: NodePath.join(f.root, "build"),
    codex: {
      configuration: await pin(
        "codex.json",
        Buffer.from(JSON.stringify(await syntheticConfiguration(expectedRelease, turn))),
      ),
      engine: await pin("synthetic-engine.wasm", engineBytes),
      commands: [],
    },
    claude: f.input,
    claudeEnvironmentPackages: {},
    claudeRuntime: {
      collectorNonce: "synthetic-collector-nonce",
      mcpProbe: {
        toolName: "mcp__executor__qualification_echo",
        input: { text: "synthetic-probe" },
        expectedText: "synthetic-probe",
      },
      model: turn.modelSelection.model,
      turnJson: {
        baseline: turns("baseline"),
        hooks: turns("hooks"),
      },
      seed,
    },
  };
}
