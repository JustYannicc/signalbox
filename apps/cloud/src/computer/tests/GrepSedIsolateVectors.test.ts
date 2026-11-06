// @effect-diagnostics nodeBuiltinImport:off - loads private verified vectors and pinned local WASM.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { expect, it, vi } from "vite-plus/test";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { KERNEL_GNU_SED_ARTIFACT } from "../../kernel/KernelGnuPrograms.ts";
import { KERNEL_UGREP_ARTIFACT } from "../../kernel/KernelUgrepProgram.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import { qualifyGnuCommand } from "../GnuCommandCompatibility.ts";
import { qualifyUgrepCommand } from "../UgrepCommand.ts";
import type { ChildWorkerCode } from "../ChildWorkerCode.ts";
import {
  commandGatewayFixture,
  commandProgramCodes,
  emptyChild,
  readAll,
} from "./CommandGatewayAdmissionFixture.ts";
import { exited } from "./ChildBusyboxFixture.ts";
import {
  GREP_SED_VECTORS,
  expectedChildArgv,
  expectedPin,
  errorDetails,
  prepareVectorWorkspace,
  type GrepSedVector,
} from "./GrepSedIsolateVectors.fixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const reportPath = NodeProcess.env.B5_VECTOR_REPORT;
const baseCommit = NodeProcess.env.B5_BASE_COMMIT;
const baseTree = NodeProcess.env.B5_BASE_TREE;
if (reportPath && (!baseCommit || !baseTree)) {
  throw new Error("Retained vector reports need a pinned base commit and tree");
}

const artifactPaths = {
  ugrep:
    NodeProcess.env.SIGNALBOX_UGREP_ARTIFACT ??
    new URL("../../../../../.t3/1071/programs/ugrep.wasm", import.meta.url),
  sed:
    NodeProcess.env.SIGNALBOX_GNU_SED_ARTIFACT ??
    new URL("../../../../../.t3/1071/programs/sed.wasm", import.meta.url),
};
function readPinnedArtifact(
  path: string | URL,
  pin: { readonly bytes: number; readonly sha256: string },
  name: string,
) {
  if (!NodeFS.existsSync(path)) throw new Error("Pinned " + name + " WASM artifact is missing");
  const bytes = NodeFS.readFileSync(path);
  if (
    bytes.byteLength !== pin.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== pin.sha256
  ) {
    throw new Error("Pinned " + name + " WASM artifact does not match its current source pin");
  }
  return bytes;
}
const ugrepBytes = readPinnedArtifact(artifactPaths.ugrep, KERNEL_UGREP_ARTIFACT, "ugrep");
const sedBytes = readPinnedArtifact(artifactPaths.sed, KERNEL_GNU_SED_ARTIFACT, "GNU sed");

function workerCode(name: string, bytes: Uint8Array): ChildWorkerCode {
  const main = name + ".js";
  const wasmName = name + ".wasm";
  const wasm = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return {
    mainModule: main,
    modules: {
      [main]: "export default class {}",
      [wasmName]: { wasm },
    },
  };
}
function wasmFromCode(modules: Readonly<Record<string, unknown>>) {
  const entries = Object.entries(modules).flatMap(([name, value]) => {
    if (typeof value !== "object" || value === null || !("wasm" in value)) return [];
    const wasm = Reflect.get(value, "wasm");
    if (wasm instanceof ArrayBuffer) return [{ name, bytes: new Uint8Array(wasm) }];
    if (ArrayBuffer.isView(wasm))
      return [{ name, bytes: new Uint8Array(wasm.buffer, wasm.byteOffset, wasm.byteLength) }];
    return [];
  });
  if (entries.length !== 1) {
    throw new Error("Expected the catalog-selected child code to carry exactly one WASM artifact");
  }
  return entries[0]!;
}
function sha256(bytes: Uint8Array) {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

if (GREP_SED_VECTORS.length !== 9) throw new Error("Expected nine regression vectors");

const vectors = GREP_SED_VECTORS.filter(({ id }) => id !== 7);
const reportRows: Record<string, unknown>[] = [];
const report = {
  baseCommit,
  baseTree,
  inputKind: "literal-decoded applet argv reproduction input, not observed expanded runtime argv",
  capturedBashArgv: "separate source evidence; not substituted into these tests",
  vectors: reportRows,
};
function persist() {
  if (reportPath) NodeFS.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}
async function runVector(vector: GrepSedVector) {
  const expectedArgvs = expectedChildArgv(vector);
  const input = Object.freeze({
    executable: vector.executable,
    argv: Object.freeze([...vector.argv]),
    cwd: "/work",
    env: Object.freeze({ LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }),
  });
  const originalInput = JSON.stringify(input);
  const localRuns: Record<string, unknown>[] = [];
  const fixture = commandGatewayFixture({
    programs: {
      ...commandProgramCodes(),
      ugrep: workerCode("ugrep", ugrepBytes),
      sed: workerCode("sed", sedBytes),
    },
    run: async (childInput, invocation) => {
      const expected = expectedPin(vector);
      const artifact = wasmFromCode(childInput.modules as Readonly<Record<string, unknown>>);
      const artifactHash = sha256(artifact.bytes);
      if (artifact.bytes.byteLength !== expected.bytes || artifactHash !== expected.sha256) {
        throw new Error("Catalog selected a different child artifact for vector " + vector.id);
      }
      const moduleBytes = artifact.bytes.buffer.slice(
        artifact.bytes.byteOffset,
        artifact.bytes.byteOffset + artifact.bytes.byteLength,
      ) as ArrayBuffer;
      const module = new WebAssembly.Module(moduleBytes);
      localRuns.push({
        executable: childInput.command.executable,
        argv: [...childInput.command.argv],
        cwd: childInput.command.cwd,
        env: { ...childInput.command.env },
        wasmModule: artifact.name,
        wasmBytes: artifact.bytes.byteLength,
        wasmSha256: artifactHash,
      });
      try {
        const port = await invocation.host<KernelBusyboxPort>();
        try {
          return await createChildBusybox({
            module,
            port,
            args: childInput.command.argv,
            env: childInput.command.env,
          }).run();
        } catch (error) {
          const run = localRuns[localRuns.length - 1];
          if (run !== undefined) run.runError = errorDetails(error);
          throw error;
        }
      } finally {
        invocation.acknowledge();
      }
    },
  });
  fixture.machineSpawn.mockImplementation(async () =>
    emptyChild({
      stderr: new TextEncoder().encode("machine execution unavailable in this fixture\n"),
      exited: Promise.resolve(exited(127)),
    }),
  );
  let child: Awaited<ReturnType<typeof fixture.gateway.exec>> | undefined;
  const row: Record<string, unknown> = {
    vector: vector.id,
    fixtureArgv: vector.argv,
    qualification: null,
    actualRoute: null,
    childRuns: localRuns,
    machineSpawnCount: 0,
    observed: null,
    fileEffects: {},
    failure: null,
  };
  try {
    prepareVectorWorkspace(fixture, vector.files);
    row.filesystemCwd = fixture.filesystem.cwd;
    const qualification =
      vector.executable === "/bin/grep"
        ? qualifyUgrepCommand(input)
        : qualifyGnuCommand(input, fixture.filesystem);
    row.qualification = qualification ?? null;
    child = await fixture.gateway.exec(input, fixture.controller.signal, undefined);
    const writer = child.stdin.getWriter();
    const stdinPromise = (async () => {
      try {
        await writer.write(new TextEncoder().encode(vector.stdin));
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    })();
    const [statusResult, stdoutResult, stderrResult, stdinResult] = await Promise.allSettled([
      child.exited,
      readAll(child.stdout),
      readAll(child.stderr),
      stdinPromise,
    ]);
    await fixture.gateway.drain();
    const observed: Record<string, unknown> = {
      exitCode: statusResult.status === "fulfilled" ? statusResult.value.exitCode : null,
      stdout:
        stdoutResult.status === "fulfilled" ? new TextDecoder().decode(stdoutResult.value) : "",
      stderr:
        stderrResult.status === "fulfilled" ? new TextDecoder().decode(stderrResult.value) : "",
    };
    if (statusResult.status === "rejected")
      observed.completionError = errorDetails(statusResult.reason);
    if (stdoutResult.status === "rejected")
      observed.stdoutError = errorDetails(stdoutResult.reason);
    if (stderrResult.status === "rejected")
      observed.stderrError = errorDetails(stderrResult.reason);
    if (stdinResult.status === "rejected") observed.stdinError = errorDetails(stdinResult.reason);
    row.actualRoute =
      localRuns.length > 0 && fixture.machineSpawn.mock.calls.length === 0 ? "isolate" : "machine";
    row.machineSpawnCount = fixture.machineSpawn.mock.calls.length;
    row.observed = observed;
    const failures: string[] = [];
    if (qualification?.kind !== "qualified-isolate")
      failures.push("qualifier did not admit isolate execution");
    if (localRuns.length !== expectedArgvs.length)
      failures.push("pinned tool dispatch count differs from the expected isolate roots");
    if (fixture.machineSpawn.mock.calls.length !== 0)
      failures.push("command spawned on the machine");
    if (row.filesystemCwd !== input.cwd)
      failures.push("fixture filesystem cwd differs from the command cwd");
    if (statusResult.status === "rejected") failures.push("child completion rejected");
    if (stdoutResult.status === "rejected") failures.push("stdout stream rejected");
    if (stderrResult.status === "rejected") failures.push("stderr stream rejected");
    if (stdinResult.status === "rejected") failures.push("stdin write rejected");
    for (const [index, run] of localRuns.entries()) {
      if (run.executable !== input.executable)
        failures.push("catalog dispatched a different executable");
      if (JSON.stringify(run.argv) !== JSON.stringify(expectedArgvs[index])) {
        failures.push("child argv differs from the exact form or its required BSD-to-GNU adapter");
      }
      if (run.cwd !== input.cwd) failures.push("child cwd changed");
      if (
        input.executable === "/bin/grep" &&
        (run.env as Record<string, unknown>).PWD !== input.cwd
      ) {
        failures.push("grep child PWD does not match its cwd");
      }
      const pin = expectedPin(vector);
      if (run.wasmBytes !== pin.bytes || run.wasmSha256 !== pin.sha256) {
        failures.push("child dispatched an artifact other than the pinned implementation");
      }
    }
    if (observed.exitCode !== vector.expectedExitCode) failures.push("exit code differs");
    if (observed.stdout !== vector.expectedStdout) failures.push("stdout differs");
    if (observed.stderr !== "") failures.push("stderr is not empty");
    for (const [relativePath, originalContents] of Object.entries(vector.files)) {
      const expectedContents =
        relativePath === vector.editedFile ? vector.editedContents! : originalContents;
      let actualContents: string | undefined;
      try {
        actualContents = fixture.read("/work/" + relativePath);
      } catch {
        actualContents = undefined;
      }
      (row.fileEffects as Record<string, unknown>)[relativePath] = {
        expected: expectedContents,
        actual: actualContents,
      };
      if (actualContents !== expectedContents)
        failures.push("file contents differ for " + relativePath);
    }
    if (vector.editedFile !== undefined) {
      const backup = "/work/" + vector.editedFile + ".bak";
      let backupExists = true;
      try {
        fixture.filesystem.lstat(backup);
      } catch {
        backupExists = false;
      }
      (row.fileEffects as Record<string, unknown>).backup = { path: backup, exists: backupExists };
      if (backupExists) failures.push("empty BSD suffix created an unwanted backup file");
    }
    if (JSON.stringify(input) !== originalInput)
      failures.push("gateway changed the original consumer command");
    if (fixture.capacity.active !== 0) failures.push("child capacity was not released");
    if (failures.length > 0) throw new Error(failures.join("; "));
  } catch (error) {
    row.failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (child !== undefined) await child.dispose();
    await fixture.close();
    reportRows.push(row);
    persist();
  }
  return row;
}

it.each(vectors)(
  "runs verified vector $id in the isolate with exact tool output",
  async (vector) => {
    const row = await runVector(vector);
    expect(row.failure).toBeNull();
  },
);

it("keeps the sed numeric range control in the local GNU sed isolate", async () => {
  const control = GREP_SED_VECTORS.find(({ id }) => id === 7)!;
  expect(await runVector(control)).toMatchObject({ failure: null, actualRoute: "isolate" });
});

it("keeps mixed recursive roots in the isolate with distinct path labels", async () => {
  const vector: GrepSedVector = {
    id: 10,
    executable: "/bin/grep",
    argv: [
      "grep",
      "-rn",
      "needle",
      ".",
      "anon-search/nested",
      "anon-search/nested/hit.txt",
      "anon-search/nested/miss.txt",
    ],
    pathReplacements: {},
    files: {
      "anon-search/nested/hit.txt": "needle first\nquiet line\n",
      "anon-search/nested/miss.txt": "nothing here\n",
      "anon-search/root.txt": "needle root\nquiet line\n",
    },
    stdin: "",
    expectedStdout:
      "./anon-search/root.txt:1:needle root\n" +
      "./anon-search/nested/hit.txt:1:needle first\n" +
      "anon-search/nested/hit.txt:1:needle first\n" +
      "anon-search/nested/hit.txt:1:needle first\n",
    expectedExitCode: 0,
  };
  const row = await runVector(vector);
  expect(row.failure).toBeNull();
  expect(row.actualRoute).toBe("isolate");
  expect(row.machineSpawnCount).toBe(0);
});

it("lists only matching include files for recursive grep in the isolate", async () => {
  const vector: GrepSedVector = {
    id: 11,
    executable: "/bin/grep",
    argv: ["grep", "-rl", "needle", "--include=*.md", "anon-search/tree"],
    pathReplacements: {},
    files: {
      "anon-search/tree/hit.md": "needle matched\nquiet\n",
      "anon-search/tree/nested/hit.md": "needle nested\n",
      "anon-search/tree/miss.md": "quiet only\n",
      "anon-search/tree/skip.txt": "needle excluded by include\n",
    },
    stdin: "",
    expectedStdout: "anon-search/tree/hit.md\nanon-search/tree/nested/hit.md\n",
    expectedExitCode: 0,
  };
  const row = await runVector(vector);
  expect(row.failure).toBeNull();
  expect(row.actualRoute).toBe("isolate");
  expect(row.machineSpawnCount).toBe(0);
});
