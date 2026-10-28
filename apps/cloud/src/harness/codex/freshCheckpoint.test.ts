import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { ProviderDriverKind } from "@t3tools/contracts";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { dataForDriver } from "../adapter/tests/data.ts";
import { fixture } from "./tests/fixture.ts";
import { echoEngine } from "./tests/wasm.ts";
import { materializeFreshCodexCheckpoint } from "../CodexIsolateAdapter.ts";

const home = "/home/test/.codex";
const path = `${home}/sessions/rollout.jsonl`;
const archived = `${home}/archived_sessions/rollout.jsonl`;

const setup = Effect.gen(function* () {
  const context = yield* Effect.acquireRelease(
    Effect.sync(() => fixture(echoEngine())),
    (value) => Effect.promise(() => value.close()),
  );
  const data = yield* dataForDriver(ProviderDriverKind.make("codex"));
  const providerThread = {
    ...data.providerThread,
    nativeThreadRef: {
      driver: data.providerThread.driver,
      nativeId: "native-id",
      strength: "strong" as const,
    },
  };
  const fs = createNodeFs(context.files).fs;
  fs.mkdirSync(`${home}/sessions`, { recursive: true });
  fs.mkdirSync(`${home}/archived_sessions`, { recursive: true });
  const contents = JSON.stringify({ type: "session_meta", payload: { id: "native-id" } }) + "\n";
  let afterUnarchive: (() => void) | undefined;
  const calls: { method: string; payload: unknown }[] = [];
  const input = {
    threadId: data.threadId,
    providerThread,
    files: context.files,
    codexHome: home,
    runtime: {
      readThreadSnapshot: () =>
        Effect.succeed({
          providerThread,
          providerTurns: [],
          messages: [],
          runtimeRequests: [],
          providerPayload: { id: "native-id", path, ephemeral: false },
        }),
    },
    client: {
      request: (method: string, payload?: unknown) =>
        Effect.sync(() => {
          calls.push({ method, payload });
          if (method === "thread/archive") fs.writeFileSync(archived, contents);
          else if (method === "thread/unarchive") {
            fs.renameSync(archived, path);
            afterUnarchive?.();
          } else throw new Error(`Unexpected native request ${method}`);
          return {};
        }),
    },
  };
  return {
    input,
    fs,
    calls,
    contents,
    setAfterUnarchive: (effect: () => void) => {
      afterUnarchive = effect;
    },
  };
});

it.effect(
  "materializes the fresh native rollout and returns only after unarchive and identity verification",
  () =>
    Effect.gen(function* () {
      const f = yield* setup;
      expect(f.fs.existsSync(path)).toBe(false);
      yield* materializeFreshCodexCheckpoint(f.input);
      expect(f.fs.readFileSync(path, "utf8")).toBe(f.contents);
      expect(f.fs.existsSync(archived)).toBe(false);
      expect(f.calls).toEqual([
        { method: "thread/archive", payload: { threadId: "native-id" } },
        { method: "thread/unarchive", payload: { threadId: "native-id" } },
      ]);
    }).pipe(Effect.scoped),
);

it.effect("preserves an already materialized native rollout without archiving it", () =>
  Effect.gen(function* () {
    const f = yield* setup;
    f.fs.writeFileSync(path, f.contents);
    yield* materializeFreshCodexCheckpoint(f.input);
    expect(f.calls).toEqual([]);
    expect(f.fs.readFileSync(path, "utf8")).toBe(f.contents);
  }).pipe(Effect.scoped),
);

it.effect.each([
  {
    name: "missing",
    change: (fs: ReturnType<typeof createNodeFs>["fs"]) => fs.unlinkSync(path),
    message: "ENOENT",
  },
  {
    name: "wrong UUID",
    change: (fs: ReturnType<typeof createNodeFs>["fs"]) =>
      fs.writeFileSync(
        path,
        JSON.stringify({ type: "session_meta", payload: { id: "different-native-id" } }) + "\n",
      ),
    message: "another native thread",
  },
  {
    name: "truncated",
    change: (fs: ReturnType<typeof createNodeFs>["fs"]) =>
      fs.writeFileSync(path, '{"type":"session_meta"'),
    message: "incomplete",
  },
])("rejects a $name rollout after the official persistence pair", ({ change, message }) =>
  Effect.gen(function* () {
    const f = yield* setup;
    f.setAfterUnarchive(() => {
      change(f.fs);
    });
    const result = yield* materializeFreshCodexCheckpoint(f.input).pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(message);
    expect(f.calls.map((call) => call.method)).toEqual(["thread/archive", "thread/unarchive"]);
  }).pipe(Effect.scoped),
);
