// @effect-diagnostics nodeBuiltinImport:off - this regression reads only the frozen image inventory.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { CHILD_PROGRAM_PATHS } from "../ChildProgramSet.ts";
import { MachineFileLookupError, type MachineFilesPort } from "../MachineFilesPort.ts";
import type { MachineProgramInventory } from "../MachineProgramInventory.ts";
import {
  bashModule,
  machinePathFixture,
  machinePathInventory,
  type MachinePathFixtureOptions,
} from "./MachinePathFixture.ts";
import { writeUpperFile } from "./MachinePathFixtureSupport.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const inventoryPath =
  NodeProcess.env.SIGNALBOX_MACHINE_PATH_INVENTORY_FILE ??
  new URL("../../../infra/kernelPrograms/machine-files/build/runner.json", import.meta.url);
if (
  NodeProcess.env.SIGNALBOX_MACHINE_PATH_INVENTORY_FILE !== undefined &&
  !NodeFS.existsSync(inventoryPath)
)
  throw new Error("Required machine inventory is missing");
const inventoryBytes = NodeFS.existsSync(inventoryPath)
  ? NodeFS.readFileSync(inventoryPath)
  : undefined;
if (
  inventoryBytes !== undefined &&
  NodeCrypto.createHash("sha256").update(inventoryBytes).digest("hex") !==
    "74186335378f14ba82d2c7ac3dfe3d2708b2b8f4f4b5faf9c009f23127ec4e19"
)
  throw new Error("Symlink regression requires the frozen machine inventory");
const inventory: MachineProgramInventory | undefined =
  inventoryBytes === undefined ? undefined : JSON.parse(inventoryBytes.toString("utf8"));

describe.skipIf(bashModule === undefined)("ProductComputer machine symlink traversal", () => {
  it.skipIf(inventory === undefined)(
    "finds a relative final symlink beneath the upper catalog directory using its physical lower parent",
    () =>
      withFixture({ inventory: inventory!, before: seedCatalog }, async (fixture) => {
        expect(inventory!.entries.find(({ path }) => path === "/bin")?.target).toBe("usr/bin");
        expect(inventory!.entries.find(({ path }) => path === "/usr/bin/py3versions")?.target).toBe(
          "../share/python3/py3versions.py",
        );
        expect(
          inventory!.entries.find(({ path }) => path === "/usr/share/python3/py3versions.py")?.mode,
        ).toBe(0o755);
        expect(inventory!.entries.find(({ path }) => path === "/share")).toBeUndefined();
        const result = await fixture.run("command -v py3versions; py3versions", "/bin");
        expect(
          result.status.exitCode,
          JSON.stringify({ result, calls: fixture.machineCalls }),
        ).toBe(23);
        expect(result.stdout).toBe("/bin/py3versions\n");
        expect(result.stderr).toBe("");
        expect(fixture.machineCalls.map(({ executable, argv }) => ({ executable, argv }))).toEqual([
          { executable: "/bin/py3versions", argv: ["py3versions"] },
        ]);
      }),
  );

  it.skipIf(inventory === undefined)(
    "retains original link metadata while an upper physical target takes precedence",
    () =>
      withFixture(
        {
          inventory: inventory!,
          before(filesystem) {
            seedCatalog(filesystem);
            writeUpperFile(
              filesystem,
              "/usr/share/python3/py3versions.py",
              "printf UPPER_PHYSICAL\n",
            );
          },
        },
        async (fixture) => {
          const captured = inventory!.entries.find(({ path }) => path === "/usr/bin/py3versions")!;
          await fixture.filesystem.prepareLowerPaths(["/bin/py3versions"]);
          expect(fixture.filesystem.lstat("/bin/py3versions")).toMatchObject({
            type: "symlink",
            size: BigInt(captured.size),
            mtimeNs: BigInt(captured.mtimeNs),
            ctimeNs: BigInt(captured.ctimeNs),
            posix: { mode: captured.mode, uid: captured.uid, gid: captured.gid },
          });
          expect(fixture.filesystem.readlink("/bin/py3versions")).toBe(captured.target);
          const result = await fixture.run("py3versions", "/bin");
          expect(result.status.exitCode).toBe(0);
          expect(result.stdout).toBe("UPPER_PHYSICAL");
          expect(result.stderr).toBe("");
          expect(fixture.machineCalls).toEqual([]);
        },
      ),
  );

  it.each([
    { state: "dirty", entry: "Bash" },
    { state: "dirty", entry: "direct exec" },
    { state: "unattested", entry: "Bash" },
    { state: "unattested", entry: "direct exec" },
  ])(
    "walks upper link/.. through $entry before querying a disconnected $state machine",
    async ({ state, entry }) => {
      const lookups: unknown[] = [];
      const files: MachineFilesPort = {
        current: () => ({
          generation: 1,
          pristine: false,
          ...(state === "dirty" ? { imageDigest: machinePathInventory.imageDigest } : {}),
        }),
        markExecuted: async () => {},
        async lookup(input) {
          lookups.push(input);
          throw new MachineFileLookupError("RUNNER_DISCONNECTED", "Runner disconnected.");
        },
      };
      await withFixture(
        {
          files,
          before(filesystem) {
            seedCatalog(filesystem);
            writeUpperFile(filesystem, "/dev/tty", "");
            writeUpperFile(filesystem, "/workspace/target/bin/tool", "printf UPPER\n");
            filesystem.mkdir("/workspace/target/sub");
            filesystem.symlink("/workspace/target/sub", "/workspace/link");
            expect(() => filesystem.lstat("/workspace/bin")).toThrow(
              expect.objectContaining({ code: "ENOENT" }),
            );
          },
        },
        async (fixture) => {
          const path = "/workspace/link/../bin";
          if (entry === "Bash") {
            const result = await fixture.direct(
              "/bin/bash",
              ["/bin/bash", "--noprofile", "--norc", "-c", "tool"],
              path,
            );
            expect(result.status.exitCode).toBe(0);
            expect(result.stdout).toBe("UPPER");
            expect(result.stderr).toBe("");
          } else {
            await expect(fixture.direct("tool", ["tool"], path)).rejects.toMatchObject({
              code: "ENOEXEC",
            });
          }
          expect(lookups).toEqual([]);
          expect(fixture.machineCalls).toEqual([]);
        },
      );
    },
  );

  it.each(["dirty", "unattested"])(
    "keeps an actually required lower lookup fatal on the disconnected %s machine",
    async (state) => {
      const lookedUp: string[] = [];
      const files: MachineFilesPort = {
        current: () => ({
          generation: 1,
          pristine: false,
          ...(state === "dirty" ? { imageDigest: machinePathInventory.imageDigest } : {}),
        }),
        markExecuted: async () => {},
        async lookup(input) {
          lookedUp.push(
            ...input.operations.flatMap((operation) =>
              "path" in operation ? [operation.path] : [],
            ),
          );
          throw new MachineFileLookupError("RUNNER_DISCONNECTED", "Runner disconnected.");
        },
      };
      await withFixture(
        {
          files,
          before(filesystem) {
            seedCatalog(filesystem);
            filesystem.mkdir("/workspace/target");
            filesystem.mkdir("/workspace/target/sub");
            filesystem.mkdir("/workspace/target/bin");
            filesystem.symlink("/workspace/target/sub", "/workspace/link");
          },
        },
        async (fixture) => {
          const writes = fixture.sqlWriteCount();
          await expect(
            fixture.direct("tool", ["tool"], "/workspace/link/../bin"),
          ).rejects.toMatchObject({ name: "KernelFileSystemUnavailable" });
          expect(lookedUp).toContain("/workspace/target/bin/tool");
          expect(lookedUp).not.toContain("/workspace/bin/tool");
          expect(lookedUp).not.toContain("/workspace/bin");
          expect(fixture.sqlWriteCount()).toBe(writes);
          expect(fixture.machineCalls).toEqual([]);
        },
      );
    },
  );
});

function seedCatalog(filesystem: Parameters<NonNullable<MachinePathFixtureOptions["before"]>>[0]) {
  for (const path of Object.values(CHILD_PROGRAM_PATHS)) writeUpperFile(filesystem, path, "");
}

async function withFixture(
  options: MachinePathFixtureOptions,
  assertions: (fixture: ReturnType<typeof machinePathFixture>) => Promise<void>,
) {
  const fixture = machinePathFixture(bashModule!, options);
  let failure: unknown;
  try {
    await assertions(fixture);
  } catch (error) {
    failure = error;
  }
  try {
    await fixture.close();
  } catch (cleanup) {
    if (failure !== undefined)
      throw new AggregateError([failure, cleanup], "Symlink assertions and cleanup failed");
    throw cleanup;
  }
  if (failure !== undefined) throw failure;
}
