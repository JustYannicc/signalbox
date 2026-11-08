// @effect-diagnostics nodeBuiltinImport:off - Real workerd consumes immutable, hash-pinned native artifacts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";
import { prepareChildPrograms } from "../../../infra/childPrograms/prepare.ts";
import { CODEX_WASI_RELEASE } from "../../../infra/codexTurn/release.ts";
import { CODE_MODE_HOST_EXECUTABLE } from "../../computer/CodeModeManifest.ts";
import { CODE_MODE_SOURCE } from "./productCodeMode/model.ts";

const releaseDir = NodeProcess.env.SIGNALBOX_CODE_MODE_RELEASE_DIR;
const programDir = NodeProcess.env.SIGNALBOX_CODE_MODE_PROGRAM_DIR;
const digest = (value: Uint8Array) => NodeCrypto.createHash("sha256").update(value).digest("hex");

// The official 0.162.1 sources are packaged as this custom WASI build, not an OpenAI prebuilt WASM release.
const MANIFEST_SHA256 = CODEX_WASI_RELEASE.files["manifest.json"].sha256;
const ENGINE_SHA256 = CODEX_WASI_RELEASE.files["engine.wasm"].sha256;

async function runProof(route: "run" | "fresh") {
  if (!releaseDir || !programDir)
    throw new Error(
      "Pinned CodeMode product inputs are required: SIGNALBOX_CODE_MODE_RELEASE_DIR and SIGNALBOX_CODE_MODE_PROGRAM_DIR. See native/codex-wasm/README.md.",
    );
  const manifest = await NodeFSP.readFile(NodePath.join(releaseDir, "manifest.json"));
  expect(digest(manifest)).toBe(MANIFEST_SHA256);
  const engine = await NodeFSP.readFile(NodePath.join(releaseDir, "engine.wasm"));
  expect(engine.byteLength).toBe(CODEX_WASI_RELEASE.files["engine.wasm"].bytes);
  expect(digest(engine)).toBe(ENGINE_SHA256);
  const prepared = await prepareChildPrograms({ programDir });
  const paths = new Set([
    "/bin/bash",
    "/bin/sh",
    "/bin/mkdir",
    "/usr/bin/mkdir",
    CODE_MODE_HOST_EXECUTABLE,
  ]);
  const files = prepared.commandExecutableFiles.filter((file) => paths.has(file.path));
  expect(files).toHaveLength(paths.size);
  const seed = files.map(({ bytes, ...file }) => ({
    ...file,
    bytes: bytes.length,
    uid: 1000,
    gid: 1000,
  }));
  const assets = Object.fromEntries(
    files.map((file) => [file.sha256, Buffer.from(file.bytes).toString("base64")]),
  );
  const staging = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "product-code-mode-"));
  let harness: ReturnType<typeof createTestHarness> | undefined;
  try {
    const entry = NodeURL.fileURLToPath(
      new URL("./productCodeMode/product.workerd.fixture.ts", import.meta.url),
    );
    const built = await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "esnext",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:workers", "node:*", "./codex-engine.wasm"],
      write: false,
    });
    const main = NodePath.join(staging, "main.mjs");
    await NodeFSP.writeFile(main, built.outputFiles[0]!.text);
    await NodeFSP.writeFile(NodePath.join(staging, "codex-engine.wasm"), engine);
    harness = createTestHarness({
      workers: [
        {
          config: {
            name: "product-codex-code-mode",
            main,
            compatibility_date: "2026-10-19",
            compatibility_flags: ["nodejs_compat"],
            worker_loaders: [{ binding: "LOADER" }],
            vars: { SOURCES: prepared.programs, SEED: seed, ASSETS: assets },
            durable_objects: { bindings: [{ name: "HOST", class_name: "Host" }] },
            migrations: [{ tag: "v1", new_sqlite_classes: ["Host"] }],
          },
        },
      ],
    });
    await harness.listen();
    const response = await harness.fetch(`http://proof/${route}`);
    const text = await response.text();
    if (NodeProcess.env.SIGNALBOX_CODE_MODE_EVIDENCE !== undefined)
      await NodeFSP.writeFile(
        `${NodeProcess.env.SIGNALBOX_CODE_MODE_EVIDENCE}.${route}.json`,
        text,
      );
    expect(response.status, text).toBe(200);
    return JSON.parse(text);
  } finally {
    await harness?.close();
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

describe("official Codex CodeMode through ProductComputer", () => {
  it("spawns the companion natively and executes the recorded exec source through the exec server", async () => {
    const body = await runProof("run");
    expect(body).toMatchObject({
      active: 0,
      processes: 0,
      result: {
        completed: { method: "turn/completed", params: { turn: { status: "completed" } } },
        directory: "directory",
        machineCalls: [],
        companionManifest: {
          status: "ok",
          value: { name: "@signalbox/codex-code-mode-host", version: "0.162.1-workerd-port.1" },
        },
      },
    });
    expect(body.result.fuzzy.files).toContainEqual(
      expect.objectContaining({
        path: "evening-routine.md",
        indices: [0, 1, 8, 11],
        score: expect.any(Number),
      }),
    );
    expect(body.result.modelsBeforeTurn).toBe(0);
    expect(body.result.cancelledSearch.directoriesRead).toBeGreaterThan(0);
    expect(body.result.cancelledSearch.directoriesRead).toBeLessThan(
      body.result.cancelledSearch.totalDirectories,
    );
    expect(body.result.cancelledSearch.directoriesRead).toBe(body.result.cancelledSearch.atStop);
    const searchEvents = body.result.replacedSearch.events;
    const completions = searchEvents.filter(
      (event: { method: string }) => event.method === "fuzzyFileSearch/sessionCompleted",
    );
    expect(completions).toHaveLength(1);
    expect(searchEvents.at(-1)?.method).toBe("fuzzyFileSearch/sessionCompleted");
    expect(searchEvents.at(-2)?.query).toBe("009");
    expect(searchEvents[0]?.query).toBe("directory");
    const spawns = body.result.nativeSpawns.filter(
      (spawn: { executable: string }) => spawn.executable === CODE_MODE_HOST_EXECUTABLE,
    );
    expect(spawns).toHaveLength(1);
    expect(spawns[0].parent).toBeDefined();
    expect(body.result.cellTools).toEqual([
      expect.arrayContaining(["exec_command"]),
      expect.arrayContaining(["exec_command"]),
    ]);
    expect(body.result.execWire).toContainEqual(
      expect.objectContaining({
        direction: "in",
        message: expect.objectContaining({
          method: "process/start",
          params: expect.objectContaining({
            cwd: "file:///work",
            argv: ["/bin/bash", "-lc", "mkdir -p docs/routines/evening"],
          }),
        }),
      }),
    );
    expect(body.result.execCalls).toHaveLength(2);
    expect(body.result.execCalls[0]).toEqual(
      expect.objectContaining({
        executable: "/bin/bash",
        cwd: "/work",
        argv: expect.arrayContaining(["mkdir -p docs/routines/evening"]),
      }),
    );
    expect(body.result.modelRequests).toHaveLength(3);
    const continued = body.result.modelRequests[1].input;
    expect(continued).toContainEqual(
      expect.objectContaining({
        type: "custom_tool_call",
        name: "exec",
        input: CODE_MODE_SOURCE,
      }),
    );
    const output = continued.find(
      (item: { call_id?: string }) => item.call_id === "call-code-mode" && "output" in item,
    );
    expect(JSON.stringify(output)).toContain("Script completed");
    const echoed = body.result.modelRequests[2].input.find(
      (item: { call_id?: string }) => item.call_id === "call-output" && "output" in item,
    );
    expect(JSON.stringify(echoed)).toContain("code-mode-output");
    expect(body.result.resultObservations).toHaveLength(2);
    for (const tool_call_id of ["call-code-mode", "call-output"]) {
      const { lifecycle } = body.result.resultObservations.find(
        (result: { tool_call_id: string }) => result.tool_call_id === tool_call_id,
      );
      expect(lifecycle).toEqual([
        expect.objectContaining({ type: "started", tool_call_id }),
        expect.objectContaining({
          type: "closed",
          started: true,
          outcome: "completed",
          error: null,
          tool_call_id,
          sessionId: lifecycle[0].sessionId,
          cellId: lifecycle[0].cellId,
        }),
      ]);
      expect(
        body.result.lifecycle.filter(
          (event: { tool_call_id: string }) => event.tool_call_id === tool_call_id,
        ),
      ).toEqual(lifecycle);
    }
  }, 120_000);
  it("creates and checkpoints a fresh thread with an existing sessions directory before any model request", async () => {
    const body = await runProof("fresh");
    expect(body).toMatchObject({
      active: 0,
      processes: 0,
      result: {
        modelRequests: [],
        snapshot: { ephemeral: false, turns: [] },
        sessionMeta: { type: "session_meta" },
      },
    });
    const reads = body.result.input
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line))
      .filter((frame: { method?: string }) => frame.method === "thread/read");
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const read of reads)
      expect(read.params).toEqual({ threadId: body.result.nativeId, includeTurns: false });
    expect(body.result.snapshot.id).toBe(body.result.nativeId);
    expect(body.result.sessionMeta.payload.id).toBe(body.result.nativeId);
    expect(body.result.snapshot.path).toMatch(/^\/home\/codex\/\.codex\/sessions\//);
    expect(body.result.stderr.join("")).not.toMatch(/panicked|unreachable|WouldBlock/);
  }, 120_000);
});
