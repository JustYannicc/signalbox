// @effect-diagnostics nodeBuiltinImport:off - Real Workerd and pinned program assets exercise the product RPC chain.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import { expect, it, describe } from "vite-plus/test";
import { build } from "esbuild";
import { createTestHarness } from "wrangler";
import { prepareChildPrograms } from "../../../infra/childPrograms/prepare.ts";

const programDir = NodeProcess.env.SIGNALBOX_RPC_ARGUMENT_PROGRAM_DIR;

describe.skipIf(programDir === undefined)("Product Claude retained RPC arguments", () => {
  it("runs later real Bash children and releases retained owners on close", async () => {
    if (programDir === undefined) throw new Error("Pinned program inputs are required");
    const cloudRoot = NodePath.resolve(import.meta.dirname, "../../..");
    const prepared = await prepareChildPrograms({ programDir, cloudRoot });
    const payloads: Record<string, string> = {};
    const seed: Record<
      string,
      { bytes: number; sha256: string; mode: number; uid: number; gid: number }
    > = {};
    for (const file of [...prepared.commandExecutableFiles, ...prepared.dataFiles]) {
      payloads[file.sha256] = Buffer.from(file.bytes).toString("base64");
      seed[file.path] = {
        bytes: file.bytes.length,
        sha256: file.sha256,
        mode: file.mode,
        uid: 1000,
        gid: 1000,
      };
    }
    for (const [path, text] of Object.entries({
      "/work/fixture.txt": "one\nneedle line\nthree\n",
      "/tmp/.keep": "",
      "/home/agent/.keep": "",
    })) {
      const bytes = Buffer.from(text);
      const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      payloads[sha256] = bytes.toString("base64");
      seed[path] = { bytes: bytes.length, sha256, mode: 0o644, uid: 1000, gid: 1000 };
    }
    const sources: Record<string, string> = {};
    for (const [name, file] of [
      [
        "KERNEL_SOURCE",
        new URL("./productHost/rpcArgumentKernel.workerd.fixture.ts", import.meta.url),
      ],
      [
        "COMPUTER_SOURCE",
        new URL("./productHost/rpcArgumentComputer.workerd.fixture.ts", import.meta.url),
      ],
    ] as const) {
      const built = await build({
        entryPoints: [NodeURL.fileURLToPath(file)],
        bundle: true,
        minify: false,
        format: "esm",
        platform: "neutral",
        mainFields: ["module", "main"],
        conditions: ["workerd", "worker", "browser"],
        target: "esnext",
        external: ["cloudflare:workers", "node:*"],
        write: false,
      });
      sources[name] = built.outputFiles[0]!.text;
    }
    const harness = createTestHarness({
      workers: [
        {
          config: {
            name: "product-claude-rpc-arguments",
            main: NodeURL.fileURLToPath(
              new URL("./productHost/rpcArgumentHost.workerd.fixture.ts", import.meta.url),
            ),
            compatibility_date: "2026-10-19",
            compatibility_flags: ["nodejs_compat"],
            worker_loaders: [{ binding: "LOADER" }],
            vars: {
              ...sources,
              MATERIALS: {
                sources: prepared.programs,
                seed,
                payloads,
                sourceIdentity: NodeCrypto.createHash("sha256")
                  .update(JSON.stringify(prepared.sourceInventory))
                  .digest("hex"),
              },
            },
            durable_objects: { bindings: [{ name: "HOST", class_name: "Host" }] },
            migrations: [{ tag: "v1", new_sqlite_classes: ["Host"] }],
          },
        },
      ],
    });
    const results: unknown[] = [];
    try {
      await harness.listen();
      const setup = await harness.fetch("http://proof/configure");
      const setupText = await setup.text();
      results.push({ setupStatus: setup.status, setupText });
      expect(setup.status, setupText).toBe(200);
      expect(JSON.parse(setupText)).toMatchObject({ configured: true });
      for (const [command, expected] of [
        ["echo hi", "hi\n"],
        ["cat fixture.txt", "one\nneedle line\nthree\n"],
        ["grep needle fixture.txt", "needle line\n"],
      ]) {
        const response = await harness.fetch(
          "http://proof/run?command=" + encodeURIComponent(command!),
        );
        const body = await response.text();
        results.push({ command, status: response.status, body });
        expect(response.status, body).toBe(200);
        expect(JSON.parse(body)).toEqual({
          stdout: expected,
          stderr: "",
          exit: { exitCode: 0, signal: 0, coreDumped: false },
        });
      }
      const close = await harness.fetch("http://proof/close");
      const closed = await close.text();
      results.push({ close: closed, status: close.status });
      expect(close.status, closed).toBe(200);
      const state = JSON.parse(closed);
      expect(state).toMatchObject({
        lateRejected: true,
        kernel: {
          activeStubs: 0,
          activeResults: 0,
          failedStubDisposals: 0,
          failedResultDisposals: 0,
        },
        computer: {
          activeStubs: 0,
          activeResults: 0,
          failedStubDisposals: 0,
          failedResultDisposals: 0,
          processSlots: { stores: 1, holders: 0, lost: 0 },
        },
      });
      expect(state.before.activeStubs).toBeGreaterThan(0);
      expect(state.computer.disposedStubs).toBeGreaterThan(0);
      expect(state.kernel.disposedStubs).toBeGreaterThanOrEqual(3);
    } finally {
      await harness.close();
      NodeProcess.stdout.write("[product-rpc-arguments] " + JSON.stringify(results) + "\n");
      if (NodeProcess.env.SIGNALBOX_RPC_ARGUMENT_EVIDENCE !== undefined)
        await NodeFSP.writeFile(
          NodeProcess.env.SIGNALBOX_RPC_ARGUMENT_EVIDENCE,
          JSON.stringify({ results, harnessClosed: true }, null, 2) + "\n",
          { flag: "wx" },
        );
    }
  }, 120000);
});
