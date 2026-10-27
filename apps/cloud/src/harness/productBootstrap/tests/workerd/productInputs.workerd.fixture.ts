import { ProviderDriverKind, RunId, RunAttemptId, NodeId, MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type { HarnessReleaseArtifact } from "../../../../harnessReleases/HarnessReleaseLedger.ts";
import type {
  HarnessProcessResumePreparedRelease,
  HarnessCProductProvider,
} from "../../../HarnessProcessResume.ts";
import type { HarnessRunArtifact } from "../../../HarnessRunStore.ts";
import {
  releaseMaterial,
  loadMaterial,
  reference as referenceArtifact,
} from "../../../processResume/tests/releaseMaterial.ts";
import { codexFixture } from "../../../releaseLoader/tests/artifactFixtures.ts";
import { loadHarnessRelease } from "../../../HarnessReleaseLoader.ts";
import { productLoadedPreparedRelease } from "../../../ProductHarnessProcessRelease.ts";
import { dataForDriver } from "../../../adapter/tests/data.ts";
import { programFixture } from "../../../tests/productHost/commands.ts";

export type FixtureRelease = {
  readonly artifact: HarnessReleaseArtifact;
  readonly expected: HarnessProcessResumePreparedRelease;
  readonly trustedComputer: { readonly sourceIdentity: string; readonly manifestSha256: string };
  readonly maxPreparedModuleBytes: number;
  readonly files: Readonly<Record<string, Uint8Array>>;
};

export type FixtureState = {
  readonly runId: string;
  readonly initialProvider: HarnessCProductProvider;
  readonly releases: Readonly<Record<HarnessCProductProvider, FixtureRelease>>;
  readonly turns: Readonly<
    Record<string, { readonly reference: HarnessRunArtifact; readonly json: string }>
  >;
  readonly programs: {
    readonly sourceIdentity: string;
    readonly codes: Awaited<ReturnType<typeof programFixture>>["codes"];
    readonly files: Awaited<ReturnType<typeof programFixture>>["seed"]["files"];
    readonly bytes: Uint8Array;
  };
};

const turnCodec = Schema.fromJsonString(Schema.toCodecJson(RunnerTurn));
const encodeTurn = Schema.encodeSync(turnCodec);

const turnFor = async (
  driver: string,
  runId: string,
  prompt: string,
  ordinal: number,
  restored: boolean,
) => {
  const data = await Effect.runPromise(dataForDriver(ProviderDriverKind.make(driver)));
  const turn = {
    ...data.turn,
    runId: RunId.make(runId),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`product-attempt-${ordinal}`),
    rootNodeId: NodeId.make(`product-root-${ordinal}`),
    message: {
      ...data.turn.message,
      messageId: MessageId.make(`product-message-${ordinal}`),
      text: prompt,
    },
    providerThread: restored
      ? {
          ...data.turn.providerThread,
          nativeThreadRef: {
            driver: data.providerThread.driver,
            nativeId: "product-native-session",
            strength: "strong" as const,
          },
        }
      : data.turn.providerThread,
  } as RunnerTurn;
  const json = encodeTurn(turn);
  const bytes = new TextEncoder().encode(json);
  const reference = await referenceArtifact(`input-${runId}`, bytes);
  return { reference, json };
};

async function codexRelease(): Promise<FixtureRelease> {
  const fixture = await codexFixture();
  const files = Object.fromEntries(fixture.files);
  const artifact: HarnessReleaseArtifact = {
    provider: "codex",
    releaseId: "workerd-c-product-codex",
    artifactHash: fixture.options.identity.artifactHash,
    artifactRef: fixture.options.identity.artifactRef,
    sourceIdentity: fixture.options.identity.sourceIdentity,
    fixtureIdentity: "workerd-c-product-codex",
    createdAt: "2026-10-27T00:00:00.000Z",
  };
  const loaded = await loadHarnessRelease({
    identity: fixture.options.identity,
    source: fixture.options.source,
    trustedComputer: fixture.options.trustedComputer,
    maxPreparedModuleBytes: fixture.options.maxPreparedModuleBytes,
  });
  return {
    artifact,
    expected: productLoadedPreparedRelease("codex", artifact, loaded),
    trustedComputer: fixture.options.trustedComputer,
    maxPreparedModuleBytes: fixture.options.maxPreparedModuleBytes,
    files,
  };
}

export async function createProductFixtureState(
  runId: string,
  initialProvider: HarnessCProductProvider = "claude-code",
): Promise<FixtureState> {
  const claude = await releaseMaterial("controlled official Claude startup", "workerd-c");
  const [claudeExpected, codex] = await Promise.all([loadMaterial(claude), codexRelease()]);
  const claudeRelease: FixtureRelease = {
    artifact: claude.artifact,
    expected: claudeExpected,
    trustedComputer: claude.trustedComputer,
    maxPreparedModuleBytes: Object.values(claude.files).reduce(
      (sum, bytes) => sum + bytes.byteLength,
      0,
    ),
    files: claude.files,
  };
  const turns = {
    "turn-one": await turnFor(
      initialProvider === "codex" ? "codex" : "claudeAgent",
      "product-turn-one",
      "Run the first controlled turn.",
      1,
      true,
    ),
    "turn-two": await turnFor(
      "codex",
      "product-turn-two",
      "Complete the resumed controlled turn.",
      2,
      initialProvider === "codex",
    ),
  };
  const program = await programFixture();
  const state: FixtureState = {
    runId,
    initialProvider,
    releases: { "claude-code": claudeRelease, codex },
    turns,
    programs: {
      sourceIdentity: program.seed.sourceIdentity,
      codes: program.codes,
      files: program.seed.files,
      bytes: await program.seed.read("/usr/bin/git", new AbortController().signal),
    },
  };
  return state;
}
