// @effect-diagnostics nodeBuiltinImport:off - compares the pinned local BusyBox artifact with GNU sed in private temporary files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { afterAll, describe, expect, it } from "vite-plus/test";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { createKernelBusyboxHost } from "../../kernel/KernelBusyboxHost.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../kernel/KernelBusyboxProgram.ts";
import { createChildBusybox } from "../ChildBusybox.ts";
import {
  GNU_SED,
  createNativeDirectory,
  decodeGuestPath,
  ensureGnuSed,
  expectedDirectory,
  fileProjection,
  inodeAt,
  kernelPreopenPath,
  readKernelFile,
  runGnuSed,
  runGnuSedWithRenameDenied,
  sedInPlaceCases,
  snapshotKernelDirectory,
  snapshotNativeDirectory,
} from "./GnuSedInPlaceFixture.ts";
import { childBusyboxFixture } from "./ChildBusyboxFixture.ts";

const artifact =
  NodeProcess.env.SIGNALBOX_BUSYBOX_ARTIFACT_PATH ??
  new URL("../../../../../.t3/1071/programs/busybox.wasm", import.meta.url);
const artifactAvailable = NodeFS.existsSync(artifact);
if (!artifactAvailable && NodeProcess.env.SIGNALBOX_REQUIRE_BUSYBOX_ARTIFACT === "1") {
  throw new Error("SIGNALBOX_REQUIRE_BUSYBOX_ARTIFACT=1 requires the pinned BusyBox WASM artifact");
}

let busyboxModule: WebAssembly.Module | undefined;
if (artifactAvailable) {
  const bytes = new Uint8Array(NodeFS.readFileSync(artifact));
  if (
    bytes.length !== KERNEL_BUSYBOX_ARTIFACT.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== KERNEL_BUSYBOX_ARTIFACT.sha256
  ) {
    throw new Error("BusyBox test artifact does not match its pin");
  }
  busyboxModule = new WebAssembly.Module(bytes);
}

const receipts: unknown[] = [];
afterAll(() => {
  const destination = NodeProcess.env.SIGNALBOX_SED_RESULT_PATH;
  if (destination === undefined) return;
  NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
  NodeFS.writeFileSync(destination, `${JSON.stringify(receipts, null, 2)}\n`, { mode: 0o600 });
  NodeFS.chmodSync(destination, 0o600);
});

describe.skipIf(busyboxModule === undefined)("pinned BusyBox sed -i versus GNU sed", () => {
  it("matches file bytes, backups, modes, and replacement behavior for the measured forms", async () => {
    const gnuVersion = ensureGnuSed();
    for (const case_ of sedInPlaceCases) {
      const fixture = childBusyboxFixture({ args: ["sed", ...case_.args], env: { LC_ALL: "C" } });
      for (const file of case_.files) fixture.write(file.name, file.before, file.mode);
      const childBefore = snapshotKernelDirectory(fixture);
      const owner = createKernelBusyboxHost({ context: fixture.context });
      let childResult: Awaited<ReturnType<ReturnType<typeof createChildBusybox>["run"]>>;
      let childAfter = childBefore;
      try {
        childResult = await createChildBusybox({
          module: busyboxModule!,
          port: owner.port,
          args: fixture.context.args,
          env: fixture.context.env,
        }).run();
        childAfter = snapshotKernelDirectory(fixture);
      } finally {
        await owner.close();
        await fixture.close();
      }

      const nativeDirectory = createNativeDirectory(case_.files);
      let nativeBefore = snapshotNativeDirectory(nativeDirectory);
      let nativeAfter = nativeBefore;
      let nativeResult: ReturnType<typeof runGnuSed>;
      try {
        nativeBefore = snapshotNativeDirectory(nativeDirectory);
        nativeResult = runGnuSed(case_.args, nativeDirectory);
        nativeAfter = snapshotNativeDirectory(nativeDirectory);
      } finally {
        NodeFS.rmSync(nativeDirectory, { recursive: true, force: true });
      }

      const replacement = case_.files.map((file) => ({
        name: file.name,
        childReplaced: inodeAt(childBefore, file.name) !== inodeAt(childAfter, file.name),
        gnuReplaced: inodeAt(nativeBefore, file.name) !== inodeAt(nativeAfter, file.name),
        childBackupRetainsOriginal:
          case_.backupSuffix === undefined
            ? undefined
            : inodeAt(childAfter, `${file.name}${case_.backupSuffix}`) ===
              inodeAt(childBefore, file.name),
        gnuBackupRetainsOriginal:
          case_.backupSuffix === undefined
            ? undefined
            : inodeAt(nativeAfter, `${file.name}${case_.backupSuffix}`) ===
              inodeAt(nativeBefore, file.name),
      }));
      receipts.push({
        case: case_.name,
        gnuExecutable: GNU_SED,
        gnuVersion,
        child: {
          exitCode: childResult.exitCode,
          stdout: [...fixture.stdout()],
          stderr: [...new TextEncoder().encode(fixture.stderr())],
          before: childBefore,
          after: childAfter,
        },
        gnu: {
          exitCode: nativeResult.status,
          signal: nativeResult.signal,
          stdout: [...nativeResult.stdout],
          stderr: [...nativeResult.stderr],
          before: nativeBefore,
          after: nativeAfter,
        },
        replacement,
      });

      expect(childResult.exitCode).toBe(0);
      expect(nativeResult.status).toBe(0);
      expect([...fixture.stdout()]).toEqual([...nativeResult.stdout]);
      expect([...new TextEncoder().encode(fixture.stderr())]).toEqual([...nativeResult.stderr]);
      const expected = expectedDirectory(case_);
      expect(fileProjection(childAfter)).toEqual(fileProjection({ entries: expected }));
      expect(fileProjection(nativeAfter)).toEqual(fileProjection({ entries: expected }));
      expect(fileProjection(childAfter)).toEqual(fileProjection(nativeAfter));
      for (const relation of replacement) {
        expect(relation.childReplaced).toBe(true);
        expect(relation.gnuReplaced).toBe(true);
        expect(relation.childReplaced).toBe(relation.gnuReplaced);
        if (case_.backupSuffix !== undefined) {
          expect(relation.childBackupRetainsOriginal).toBe(true);
          expect(relation.gnuBackupRetainsOriginal).toBe(true);
        }
      }
    }
  });

  it("matches symlink and hardlink in-place effects", async () => {
    const gnuVersion = ensureGnuSed();
    for (const kind of ["symlink", "hardlink"] as const) {
      const script = "s/needle/thread/g";
      const editedName = kind === "symlink" ? "link.txt" : "hard.txt";
      const sourceFile =
        kind === "symlink"
          ? { name: "target.txt", before: "needle target\n", after: "needle target\n", mode: 0o640 }
          : { name: "hard.txt", before: "needle shared\n", after: "thread shared\n", mode: 0o640 };
      const fixture = childBusyboxFixture({
        args: ["sed", "-i", script, editedName],
        env: { LC_ALL: "C" },
      });
      fixture.write(sourceFile.name, sourceFile.before, sourceFile.mode);
      if (kind === "symlink") fixture.filesystem.symlink("target.txt", "link.txt");
      else fixture.filesystem.link("hard.txt", "alias.txt");
      const childBefore = snapshotKernelDirectory(fixture);
      const owner = createKernelBusyboxHost({ context: fixture.context });
      let childResult: Awaited<ReturnType<ReturnType<typeof createChildBusybox>["run"]>>;
      let childAfter = childBefore;
      try {
        childResult = await createChildBusybox({
          module: busyboxModule!,
          port: owner.port,
          args: fixture.context.args,
          env: fixture.context.env,
        }).run();
        childAfter = snapshotKernelDirectory(fixture);
      } finally {
        await owner.close();
        await fixture.close();
      }

      const nativeDirectory = createNativeDirectory([sourceFile]);
      if (kind === "symlink")
        NodeFS.symlinkSync("target.txt", NodePath.join(nativeDirectory, "link.txt"));
      else
        NodeFS.linkSync(
          NodePath.join(nativeDirectory, "hard.txt"),
          NodePath.join(nativeDirectory, "alias.txt"),
        );
      const nativeBefore = snapshotNativeDirectory(nativeDirectory);
      let nativeResult: ReturnType<typeof runGnuSed>;
      let nativeAfter = nativeBefore;
      try {
        nativeResult = runGnuSed(["-i", script, editedName], nativeDirectory);
        nativeAfter = snapshotNativeDirectory(nativeDirectory);
      } finally {
        NodeFS.rmSync(nativeDirectory, { recursive: true, force: true });
      }
      receipts.push({
        case: `${kind} in-place replacement`,
        gnuExecutable: GNU_SED,
        gnuVersion,
        child: {
          exitCode: childResult.exitCode,
          stdout: [...fixture.stdout()],
          stderr: [...new TextEncoder().encode(fixture.stderr())],
          before: childBefore,
          after: childAfter,
        },
        gnu: {
          exitCode: nativeResult.status,
          signal: nativeResult.signal,
          stdout: [...nativeResult.stdout],
          stderr: [...nativeResult.stderr],
          before: nativeBefore,
          after: nativeAfter,
        },
      });

      expect(childResult.exitCode).toBe(0);
      expect(nativeResult.status).toBe(0);
      expect([...fixture.stdout()]).toEqual([...nativeResult.stdout]);
      expect([...new TextEncoder().encode(fixture.stderr())]).toEqual([...nativeResult.stderr]);
      expect(fileProjection(childAfter)).toEqual(fileProjection(nativeAfter));
      expect(childAfter.entries.map((entry) => entry.name)).toEqual(
        kind === "symlink" ? ["link.txt", "target.txt"] : ["alias.txt", "hard.txt"],
      );
      if (kind === "symlink") {
        expect(childBefore.entries.find((entry) => entry.name === "link.txt")).toMatchObject({
          type: "symlink",
          linkTarget: "target.txt",
        });
        expect(childAfter.entries.find((entry) => entry.name === "target.txt")?.bytes).toEqual(
          childBefore.entries.find((entry) => entry.name === "target.txt")?.bytes,
        );
        expect(childAfter.entries.find((entry) => entry.name === "link.txt")).toMatchObject({
          type: "file",
          bytes: [...Buffer.from("thread target\n")],
        });
        expect(
          childAfter.entries.find((entry) => entry.name === "link.txt")?.linkTarget,
        ).toBeUndefined();
        expect(inodeAt(childAfter, "target.txt")).toBe(inodeAt(childBefore, "target.txt"));
        expect(inodeAt(childAfter, "link.txt")).not.toBe(inodeAt(childBefore, "link.txt"));
      } else {
        expect(inodeAt(childBefore, "hard.txt")).toBe(inodeAt(childBefore, "alias.txt"));
        expect(inodeAt(childAfter, "alias.txt")).toBe(inodeAt(childBefore, "alias.txt"));
        expect(inodeAt(childAfter, "hard.txt")).not.toBe(inodeAt(childBefore, "hard.txt"));
        expect(childAfter.entries.find((entry) => entry.name === "alias.txt")?.bytes).toEqual([
          ...Buffer.from("needle shared\n"),
        ]);
        expect(inodeAt(nativeBefore, "hard.txt")).toBe(inodeAt(nativeBefore, "alias.txt"));
        expect(inodeAt(nativeAfter, "alias.txt")).toBe(inodeAt(nativeBefore, "alias.txt"));
        expect(nativeAfter.entries.find((entry) => entry.name === "alias.txt")?.bytes).toEqual([
          ...Buffer.from("needle shared\n"),
        ]);
      }
      if (kind === "symlink") {
        expect(nativeBefore.entries.find((entry) => entry.name === "link.txt")).toMatchObject({
          type: "symlink",
          linkTarget: "target.txt",
        });
        expect(nativeAfter.entries.find((entry) => entry.name === "target.txt")?.bytes).toEqual(
          nativeBefore.entries.find((entry) => entry.name === "target.txt")?.bytes,
        );
      }
      expect(inodeAt(nativeAfter, kind === "symlink" ? "target.txt" : "alias.txt")).toBe(
        inodeAt(nativeBefore, kind === "symlink" ? "target.txt" : "alias.txt"),
      );
      expect(inodeAt(nativeAfter, editedName)).not.toBe(inodeAt(nativeBefore, editedName));
    }
  });

  it.skipIf(NodeProcess.platform !== "darwin")(
    "leaves the original intact when the temporary-file rename fails",
    async () => {
      const gnuVersion = ensureGnuSed();
      const file = {
        name: "rename.txt",
        before: "needle\nkeep\nno-final-newline",
        after: "thread\nkeep\nno-final-newline",
        mode: 0o640,
      } as const;
      const args = ["-i", "s/needle/thread/g", file.name];
      const fixture = childBusyboxFixture({ args: ["sed", ...args], env: { LC_ALL: "C" } });
      fixture.write(file.name, file.before, file.mode);
      const childBefore = snapshotKernelDirectory(fixture);
      const owner = createKernelBusyboxHost({ context: fixture.context });
      const renameAttempts: Array<{
        source: string;
        destination: string;
        sourceExists: boolean;
        sourceBytes: readonly number[];
        sourceMode: number | undefined;
        destinationBytes: readonly number[];
      }> = [];
      const port: KernelBusyboxPort = {
        call: async (request) => {
          if (request.name === "path_rename") {
            const source = decodeGuestPath(request, 1, 2);
            const destination = decodeGuestPath(request, 4, 5);
            if (destination.split("/").at(-1) === file.name) {
              const sourcePath = kernelPreopenPath(source);
              let sourceExists = false;
              let sourceBytes: readonly number[] = [];
              let sourceMode: number | undefined;
              try {
                const stat = fixture.filesystem.lstat(sourcePath);
                sourceExists = stat.type === "file";
                sourceMode = fixture.filesystem.getPosixMetadata(sourcePath).mode;
                if (sourceExists) sourceBytes = [...readKernelFile(fixture, sourcePath)];
              } catch {
                sourceExists = false;
              }
              renameAttempts.push({
                source,
                destination,
                sourceExists,
                sourceBytes,
                sourceMode,
                destinationBytes: [...readKernelFile(fixture, `/workspace/${file.name}`)],
              });
              return { kind: "return", value: 63, regions: [] };
            }
          }
          return owner.port.call(request);
        },
        callBusybox: (request) => owner.port.callBusybox(request),
      };
      let childResult: Awaited<ReturnType<ReturnType<typeof createChildBusybox>["run"]>>;
      let childAfter = childBefore;
      try {
        childResult = await createChildBusybox({
          module: busyboxModule!,
          port,
          args: fixture.context.args,
          env: fixture.context.env,
        }).run();
        childAfter = snapshotKernelDirectory(fixture);
      } finally {
        await owner.close();
        await fixture.close();
      }

      const nativeDirectory = createNativeDirectory([file]);
      const target = NodePath.join(nativeDirectory, file.name);
      const nativeBefore = snapshotNativeDirectory(nativeDirectory);
      let nativeResult: ReturnType<typeof runGnuSedWithRenameDenied>;
      let nativeAfter = nativeBefore;
      try {
        nativeResult = runGnuSedWithRenameDenied(args, nativeDirectory, target);
        nativeAfter = snapshotNativeDirectory(nativeDirectory);
      } finally {
        NodeFS.rmSync(nativeDirectory, { recursive: true, force: true });
      }
      const gnuStderr = nativeResult.stderr.toString("utf8");
      const renameError = /cannot rename (.+) to (.+): Operation not permitted/.exec(gnuStderr);
      receipts.push({
        case: "-i rename denied after temporary output",
        gnuExecutable: GNU_SED,
        gnuVersion,
        child: {
          exitCode: childResult.exitCode,
          stdout: [...fixture.stdout()],
          stderr: [...new TextEncoder().encode(fixture.stderr())],
          before: childBefore,
          after: childAfter,
          renameAttempts,
        },
        gnu: {
          exitCode: nativeResult.status,
          signal: nativeResult.signal,
          stdout: [...nativeResult.stdout],
          stderr: [...nativeResult.stderr],
          before: nativeBefore,
          after: nativeAfter,
          renameError:
            renameError === null ? null : { source: renameError[1], destination: renameError[2] },
        },
      });

      expect(renameAttempts).toHaveLength(1);
      expect(renameAttempts[0]?.sourceExists).toBe(true);
      expect(renameAttempts[0]?.sourceBytes).toEqual([...Buffer.from(file.after, "utf8")]);
      expect(renameAttempts[0]?.sourceMode).toBe(file.mode);
      expect(renameAttempts[0]?.destinationBytes).toEqual([...Buffer.from(file.before, "utf8")]);
      expect(childResult.exitCode).not.toBe(0);
      expect(nativeResult.status).not.toBe(0);
      expect(nativeResult.stdout.length).toBe(0);
      expect(renameError).not.toBeNull();
      expect([target, file.name]).toContain(renameError?.[2]);
      expect(fileProjection(childAfter)).toEqual(fileProjection(nativeAfter));
      expect(fileProjection(childAfter)).toEqual([
        {
          name: file.name,
          type: "file",
          bytes: [...Buffer.from(file.before, "utf8")],
          mode: file.mode,
        },
      ]);
      expect(inodeAt(childAfter, file.name)).toBe(inodeAt(childBefore, file.name));
      expect(inodeAt(nativeAfter, file.name)).toBe(inodeAt(nativeBefore, file.name));
      expect(childAfter.entries.map((entry) => entry.name)).toEqual([file.name]);
      expect(nativeAfter.entries.map((entry) => entry.name)).toEqual([file.name]);
    },
  );
});
