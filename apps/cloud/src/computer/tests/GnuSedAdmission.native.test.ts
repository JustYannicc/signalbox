// @effect-diagnostics nodeBuiltinImport:off - opt-in comparison runs real GNU sed on synthetic files only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { commandGatewayFixture, emptyChild, readAll } from "./CommandGatewayAdmissionFixture.ts";
import { exited } from "./ChildBusyboxFixture.ts";
import {
  createNativeDirectory,
  ensureGnuSed,
  fileProjection,
  GNU_SED,
  runGnuSed,
  snapshotKernelDirectory,
  snapshotNativeDirectory,
} from "./GnuSedInPlaceFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const requested = NodeProcess.env.SIGNALBOX_GNU_SED_REFERENCE === "1";
if (requested && NodeProcess.getuid?.() === 0) {
  throw new Error("The GNU sed directory-permission reference requires a non-root user");
}

describe.skipIf(!requested)("sed edit permission admission versus GNU", () => {
  it.each(["-i", "-i.bak"])(
    "forwards %s before effects and preserves GNU's error",
    async (option) => {
      const version = ensureGnuSed();
      const file = { name: "input", before: "needle\n", after: "thread\n", mode: 0o640 };
      const nativeDirectory = createNativeDirectory([file]);
      const fixture = commandGatewayFixture({
        run: async () => {
          throw new Error("Denied edit reached an isolate child");
        },
      });
      fixture.write(file.name, file.before, file.mode);
      NodeFS.chmodSync(nativeDirectory, 0o555);
      fixture.filesystem.chmod("/workspace", 0o555);
      const nativeBefore = snapshotNativeDirectory(nativeDirectory);
      const kernelBefore = snapshotKernelDirectory(fixture);
      let reference: ReturnType<typeof runGnuSed> | undefined;
      fixture.machineSpawn.mockImplementationOnce(async (command) => {
        reference = runGnuSed(command.argv.slice(1), nativeDirectory);
        if (reference.status === null) throw new Error("GNU sed did not return an exit status");
        return emptyChild({
          stdout: reference.stdout,
          stderr: reference.stderr,
          exited: Promise.resolve(exited(reference.status)),
        });
      });
      const command = {
        executable: "/bin/sed",
        argv: ["sed", option, "s/needle/thread/g", file.name],
        cwd: "/workspace",
        env: { LC_ALL: "C" },
      };
      try {
        const child = await fixture.gateway.exec(command, fixture.controller.signal);
        let stdout: Uint8Array;
        let stderr: Uint8Array;
        let status: Awaited<typeof child.exited>;
        try {
          [stdout, stderr, status] = await Promise.all([
            readAll(child.stdout),
            readAll(child.stderr),
            child.exited,
          ]);
        } finally {
          await child.dispose();
        }
        await fixture.gateway.drain();
        if (reference === undefined) throw new Error("Edit was not forwarded to GNU sed");
        const nativeAfter = snapshotNativeDirectory(nativeDirectory);
        const kernelAfter = snapshotKernelDirectory(fixture);
        expect(reference.status).toBe(4);
        expect(reference.stderr.toString("utf8")).toMatch(
          /^sed: couldn't open temporary file .+: Permission denied\n$/,
        );
        expect(status).toEqual(exited(4));
        expect(stdout).toEqual(new Uint8Array(reference.stdout));
        expect(stderr).toEqual(new Uint8Array(reference.stderr));
        expect(fixture.machineSpawn).toHaveBeenCalledOnce();
        expect(fixture.machineSpawn.mock.calls[0]?.[0]).toEqual(command);
        expect(fileProjection(kernelAfter)).toEqual(fileProjection(nativeAfter));
        expect(kernelAfter).toEqual(kernelBefore);
        expect(nativeAfter).toEqual(nativeBefore);
        expect(fixture.filesystem.getPosixMetadata("/workspace").mode).toBe(0o555);
        expect(NodeFS.statSync(nativeDirectory).mode & 0o777).toBe(0o555);
        expect(fixture.capacity.active).toBe(0);
        const destination = NodeProcess.env.SIGNALBOX_SED_PERMISSION_RESULT_DIR;
        if (destination !== undefined) {
          NodeFS.mkdirSync(destination, { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(destination, `permission-${option.slice(1)}.json`),
            `${JSON.stringify(
              {
                gnuExecutable: GNU_SED,
                version,
                option,
                status,
                stdout: [...stdout],
                stderr: [...stderr],
                nativeBefore,
                nativeAfter,
                kernelBefore,
                kernelAfter,
                childStarts: 0,
                machineCalls: 1,
              },
              null,
              2,
            )}\n`,
            { flag: "wx", mode: 0o600 },
          );
        }
      } finally {
        NodeFS.chmodSync(nativeDirectory, 0o755);
        NodeFS.rmSync(nativeDirectory, { recursive: true, force: true });
        await fixture.close();
      }
    },
  );
});
