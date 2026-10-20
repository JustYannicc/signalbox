import { RunnerTurn, type RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HarnessError, type HarnessCheckpoint } from "../../Harness.ts";
import {
  HarnessRequestFacetError,
  type HarnessFacetRequestContext,
} from "../../HarnessRequestFacet.ts";
import {
  createHarnessRequestTurn,
  type HarnessRequestTurnOptions,
  type HarnessRequestTurnTerminal,
} from "../../HarnessRequestTurn.ts";
import type { HarnessRunArtifact } from "../../HarnessRunStore.ts";
import type { HarnessHostOptions } from "../../HarnessSessionHost.ts";
import { hostFixture, writeFixtureFile } from "../../tests/hostFixture.ts";

const codec = Schema.fromJsonString(Schema.toCodecJson(RunnerTurn));
const encode = Schema.encodeSync(codec);
const decode = Schema.decodeSync(codec);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const digest = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

export const requestFixture = Effect.gen(function* () {
  const f = yield* hostFixture;
  const instance = yield* f.make();
  const artifacts = new Map<string, Uint8Array>();
  const save = (id: string, text: string) =>
    Effect.tryPromise({
      try: async () => {
        const bytes = new TextEncoder().encode(text);
        artifacts.set(id, bytes);
        return { id, bytes: bytes.length, sha256: await digest(bytes) };
      },
      catch: () => new HarnessRequestFacetError("Fixture artifact write failed."),
    });
  const verify: HarnessRequestTurnOptions<unknown>["verify"] = (ref) =>
    Effect.tryPromise({
      try: async () => {
        const bytes = artifacts.get(ref.id);
        if (!bytes || bytes.length !== ref.bytes || (await digest(bytes)) !== ref.sha256)
          throw new Error("Artifact mismatch");
      },
      catch: () => new HarnessRequestFacetError("Artifact verification failed."),
    });
  const initial = {
    native: yield* save("seed-native", "native seed"),
    filesystem: yield* save("seed-files", "filesystem seed"),
  };
  const firstInput = yield* save("input-1", encode(instance.adapter.turn));
  const publications: RunnerItem[] = [];
  const exports: HarnessCheckpoint[] = [];
  const terminals: HarnessRequestTurnTerminal[] = [];
  const checks: string[] = [];
  const progress: string[] = [];
  const order: string[] = [];
  const signals: AbortSignal[] = [];
  let nativeOpens = 0;
  let allow = true;
  let beforePublication: (item: RunnerItem) => Effect.Effect<void, HarnessRequestFacetError> = () =>
    Effect.void;
  let host: HarnessHostOptions<{ readonly secret: string }> = {
    ...instance.options,
    buildRuntime: (input) =>
      Effect.gen(function* () {
        order.push("native-open");
        nativeOpens++;
        signals.push(input.signal);
        if (input.harness.computer.files.stat("/restored-native").size !== 12n)
          return yield* Effect.fail(
            new HarnessError({ operation: "open", message: "Restore missing" }),
          );
        return yield* instance.options.buildRuntime(input);
      }),
  };
  const options: HarnessRequestTurnOptions<{ readonly secret: string }> = {
    restore: () =>
      Effect.sync(() => {
        order.push("restore");
        f.mutateFiles((files) => writeFixtureFile(files, "/restored-native", "native bytes"));
        return {
          host,
          open: { session: instance.adapter.input.session, bootAttemptId: "request-boot-1" },
        };
      }),
    readInput: (ref, context) =>
      Effect.try({
        try: () => {
          const bytes = artifacts.get(ref.id);
          if (!bytes) throw new Error("Input missing");
          return {
            turn: decode(new TextDecoder().decode(bytes)),
            access: f.access(context.requestId),
          };
        },
        catch: () => new HarnessRequestFacetError("Fixture input invalid."),
      }),
    onEvent: (item, context) =>
      Effect.gen(function* () {
        yield* beforePublication(item);
        publications.push(item);
        return yield* save(`event-${context.requestId}-${publications.length}`, json(item));
      }),
    writeCheckpoint: (checkpoint, context) =>
      Effect.gen(function* () {
        order.push("write-checkpoint");
        exports.push(checkpoint);
        return {
          native: yield* save(`native-${context.requestId}`, json(checkpoint)),
          filesystem: yield* save(`filesystem-${context.requestId}`, checkpoint.revision.commit),
        };
      }),
    writeResult: ({ terminal }, context) =>
      Effect.gen(function* () {
        terminals.push(terminal);
        return yield* save(`result-${context.requestId}`, json(terminal));
      }),
    verify,
  };
  const context = (id: string, controller = new AbortController()): HarnessFacetRequestContext => ({
    requestId: id,
    publisher: { generation: 1, facetNonce: "facet", publisherKey: "p".repeat(32) },
    signal: controller.signal,
    check: Effect.suspend(() => {
      checks.push(id);
      return allow
        ? Effect.void
        : Effect.fail(new HarnessRequestFacetError("Independent store fenced this request."));
    }),
    progress: (_kind, _reference) =>
      Effect.sync(() => {
        progress.push(id);
      }),
  });
  return {
    f,
    instance,
    initial,
    firstInput,
    options,
    context,
    publications,
    exports,
    terminals,
    checks,
    progress,
    order,
    signals,
    get nativeOpens() {
      return nativeOpens;
    },
    get harness() {
      return f.runtimeInput.harness;
    },
    open: (current: HarnessFacetRequestContext) =>
      createHarnessRequestTurn(options)(initial, current),
    input: (id: string, turn: RunnerTurn) => save(id, encode(turn)),
    save,
    verify,
    setAllowed: (value: boolean) => {
      allow = value;
    },
    setPublication: (effect: typeof beforePublication) => {
      beforePublication = effect;
    },
    setHost: (override: Partial<typeof host>) => {
      host = { ...host, ...override };
    },
    reference: (id: string): HarnessRunArtifact => {
      const bytes = artifacts.get(id);
      if (!bytes) throw new Error("Missing artifact");
      return { id, bytes: bytes.length, sha256: "0".repeat(64) };
    },
  };
});
