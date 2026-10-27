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
import { codexEngineBytes } from "./codexEngineWasm.fixture.ts";

export type FixtureRelease = {
  readonly artifact: HarnessReleaseArtifact;
  readonly expected: HarnessProcessResumePreparedRelease;
  readonly trustedComputer: { readonly sourceIdentity: string; readonly manifestSha256: string };
  readonly maxPreparedModuleBytes: number;
};

type FixtureReleaseSeed = FixtureRelease & {
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

export type ProductFixtureStateSeed = {
  readonly state: FixtureState;
  readonly releaseFiles: Readonly<
    Record<HarnessCProductProvider, Readonly<Record<string, Uint8Array>>>
  >;
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

async function codexRelease(
  r18Files?: Readonly<Record<string, Uint8Array>>,
): Promise<FixtureReleaseSeed> {
  let files: Record<string, Uint8Array>;
  let identity: {
    readonly artifactRef: string;
    readonly artifactHash: string;
    readonly sourceIdentity: string;
  };
  let source: { read(artifactRef: string, path: string): Promise<Uint8Array> };
  let trustedComputer: { readonly sourceIdentity: string; readonly manifestSha256: string };
  let maxPreparedModuleBytes: number;
  if (r18Files === undefined) {
    const fixture = await codexFixture({ engineBytes: codexEngineBytes() });
    files = Object.fromEntries(fixture.files);
    identity = fixture.options.identity;
    source = fixture.options.source;
    trustedComputer = fixture.options.trustedComputer;
    maxPreparedModuleBytes = fixture.options.maxPreparedModuleBytes;
  } else {
    files = Object.fromEntries(Object.entries(r18Files).filter(([path]) => path !== "worker.js"));
    const manifestBytes = files["manifest.json"];
    const codexManifestBytes = files["codex/manifest.json"];
    if (manifestBytes === undefined || codexManifestBytes === undefined)
      throw new Error("The pinned R18 release is missing its manifests.");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const commonManifest = JSON.parse(decoder.decode(manifestBytes)) as {
      readonly sourceIdentity: string;
      readonly computer: { readonly sourceIdentity: string; readonly manifestSha256: string };
    };
    const codexManifest = JSON.parse(decoder.decode(codexManifestBytes)) as {
      readonly moduleBudgetBytes: number;
    };
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(manifestBytes).buffer);
    const artifactHash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    identity = {
      artifactRef: `sha256:${artifactHash}`,
      artifactHash,
      sourceIdentity: commonManifest.sourceIdentity,
    };
    source = {
      async read(artifactRef, path) {
        if (artifactRef !== identity.artifactRef)
          throw new Error("The fixture release reader received another artifact.");
        const bytes = files[path];
        if (bytes === undefined) throw new Error(`Missing fixture release file: ${path}`);
        return bytes;
      },
    };
    trustedComputer = commonManifest.computer;
    maxPreparedModuleBytes = codexManifest.moduleBudgetBytes;
  }
  const artifactHash = identity.artifactHash;
  const artifact: HarnessReleaseArtifact = {
    provider: "codex",
    releaseId: r18Files === undefined ? "workerd-c-product-codex" : "codex-r15-b09482bc-r18",
    artifactHash,
    artifactRef: identity.artifactRef,
    sourceIdentity: identity.sourceIdentity,
    fixtureIdentity: "workerd-c-product-codex",
    createdAt: "2026-10-27T00:00:00.000Z",
  };
  const loaded = await loadHarnessRelease({
    identity,
    source,
    trustedComputer,
    maxPreparedModuleBytes,
  });
  return {
    artifact,
    expected: productLoadedPreparedRelease("codex", artifact, loaded),
    trustedComputer,
    maxPreparedModuleBytes,
    files,
  };
}

export async function createProductFixtureState(
  runId: string,
  initialProvider: HarnessCProductProvider = "claude-code",
  codexFiles?: Readonly<Record<string, Uint8Array>>,
): Promise<ProductFixtureStateSeed> {
  const claude = await releaseMaterial("controlled official Claude startup", "workerd-c");
  const [claudeExpected, codex] = await Promise.all([
    loadMaterial(claude),
    codexRelease(codexFiles),
  ]);
  const claudeMetadata: FixtureRelease = {
    artifact: claude.artifact,
    expected: claudeExpected,
    trustedComputer: claude.trustedComputer,
    maxPreparedModuleBytes: Object.values(claude.files).reduce(
      (sum, bytes) => sum + bytes.byteLength,
      0,
    ),
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
    releases: {
      "claude-code": claudeMetadata,
      codex: {
        artifact: codex.artifact,
        expected: codex.expected,
        trustedComputer: codex.trustedComputer,
        maxPreparedModuleBytes: codex.maxPreparedModuleBytes,
      },
    },
    turns,
    programs: {
      sourceIdentity: program.seed.sourceIdentity,
      codes: program.codes,
      files: program.seed.files,
      bytes: await program.seed.read("/usr/bin/git", new AbortController().signal),
    },
  };
  return {
    state,
    releaseFiles: { "claude-code": claude.files, codex: codex.files },
  };
}
