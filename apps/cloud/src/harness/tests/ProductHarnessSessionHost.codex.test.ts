import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type { CodexHarnessProcess, CodexHarnessProcessOptions } from "../CodexHarnessProcess.ts";
import { codexFixture, claudeFixture } from "../releaseLoader/tests/artifactFixtures.ts";
import {
  processFixture,
  readyLine,
  session as codexSession,
} from "../codex/tests/preinitializedFixture.ts";
import { productOptions } from "./productHost/codex.ts";

const launch = vi.hoisted(() =>
  vi.fn<(input: CodexHarnessProcessOptions) => Promise<CodexHarnessProcess>>(),
);
const captureProductComputer = vi.hoisted(() =>
  vi.fn<(options: { readonly home?: string }) => void>(),
);
vi.mock("../CodexHarnessProcess.ts", () => ({ startCodexHarnessProcess: launch }));
vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
vi.mock("../../computer/ProductComputer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../computer/ProductComputer.ts")>();
  return {
    ...actual,
    createProductComputer: (options: Parameters<typeof actual.createProductComputer>[0]) => {
      captureProductComputer(options);
      return actual.createProductComputer(options);
    },
  };
});

const services = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer);

it.effect(
  "routes the public Codex composition through its bound Computer and native transports",
  () =>
    Effect.gen(function* () {
      launch.mockReset();
      const release = yield* Effect.promise(codexFixture);
      const product = yield* productOptions(release.options);
      const peer = processFixture();
      yield* Effect.addFinalizer(() => Effect.promise(() => peer.process.abort()));
      (yield* Effect.promise(() => peer.output)).enqueue(new TextEncoder().encode(readyLine));
      let processOptions: CodexHarnessProcessOptions | undefined;
      launch.mockImplementation(async (input) => {
        processOptions = input;
        return peer.process;
      });
      const session = yield* product.host.open({
        session: codexSession,
        bootAttemptId: "product-codex-open",
      });
      yield* Effect.addFinalizer(() => Effect.orDie(session.dispose));
      if (processOptions === undefined) throw new Error("Codex process did not start");
      expect(processOptions.computer).toBe(product.host.computer);
      expect(processOptions.host).toBe(product.host.commands.host);
      expect(processOptions.stdio.filesystem).toBe(product.host.computer.files);
      processOptions.stdio.assertBound(product.host.computer.files);

      const model = yield* Effect.promise(() =>
        processOptions!.fetch(new Request("https://models.product.test/v1")),
      );
      expect(yield* Effect.promise(() => model.text())).toBe("product model transport");
      expect(product.modelCalls).toBe(1);
      const local = yield* Effect.promise(() =>
        processOptions!.fetch(new Request("http://127.0.0.1:8787/")),
      );
      expect(yield* Effect.promise(() => local.text())).toBe("port");
      yield* Effect.promise(() =>
        expect(
          processOptions!.fetch(new Request("https://harness-mcp.invalid/no-active-route")),
        ).rejects.toMatchObject({ message: "Harness MCP request is unavailable." }),
      );
      const external = yield* Effect.promise(() =>
        processOptions!.fetch(new Request("https://external.product.test/")),
      );
      expect(yield* Effect.promise(() => external.text())).toBe("fallback fetch");
      expect(product.fallbackCalls).toBe(1);

      const computerOptions = captureProductComputer.mock.calls.at(-1)?.[0];
      expect(computerOptions?.home).toBe("/home/product-codex");
      const native = product.options.native;
      if (native.harness !== "codex") throw new Error("Expected Codex native options");
      expect(computerOptions?.home).toBe(native.process.environment.HOME);
      expect(computerOptions?.home).not.toBe(native.process.bootstrap.codex_home);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect(
  "rejects a Codex binding against a Claude release before starting the native engine",
  () =>
    Effect.gen(function* () {
      launch.mockReset();
      const release = yield* Effect.promise(() => claudeFixture());
      const product = yield* productOptions(release.options);
      const outcome = yield* product.host
        .open({ session: codexSession, bootAttemptId: "mismatched-product-release" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(launch).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("rejects a non-absolute Codex HOME before starting the native engine", () =>
  Effect.gen(function* () {
    launch.mockReset();
    const release = yield* Effect.promise(codexFixture);
    const product = yield* productOptions(release.options, "relative/home");
    const outcome = yield* product.host
      .open({ session: codexSession, bootAttemptId: "invalid-product-home" })
      .pipe(Effect.exit);
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(launch).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("closes product stdio and Computer after native acquisition fails", () =>
  Effect.gen(function* () {
    launch.mockReset();
    const release = yield* Effect.promise(codexFixture);
    const product = yield* productOptions(release.options);
    const nativeFailure = new Error("native initialization failed", {
      cause: new Error("missing WASI import"),
    });
    let processOptions: CodexHarnessProcessOptions | undefined;
    launch.mockImplementation(async (input) => {
      processOptions = input;
      throw nativeFailure;
    });
    const result = yield* product.host
      .open({
        session: codexSession,
        bootAttemptId: "failed-product-native",
      })
      .pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    if (processOptions === undefined) throw new Error("Native acquisition was not attempted");
    expect(processOptions.signal.aborted).toBe(true);
    expect(() => processOptions!.stdio.assertBound(product.host.computer.files)).toThrow(
      "disposed",
    );
    expect(() => product.host.computer.files.stat("/bin/bash")).toThrow("disposed");
    if (Exit.isSuccess(result)) throw new Error("Expected native failure");
    expect(Cause.pretty(result.cause)).toContain("native initialization failed");
    const rows = [
      ...product.options.files.database.sql.exec("SELECT error_json FROM harness_host_failures"),
    ];
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.error_json)).toContain("missing WASI import");
  }).pipe(Effect.scoped, Effect.provide(services)),
);
