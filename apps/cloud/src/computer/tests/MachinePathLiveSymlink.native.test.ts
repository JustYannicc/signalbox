// @effect-diagnostics nodeBuiltinImport:off - the public regression uses only the frozen image artifact.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { CHILD_PROGRAM_PATHS } from "../ChildProgramSet.ts";
import type { MachineProgramInventory } from "../MachineProgramInventory.ts";
import type { MachineFilesPort } from "../MachineFilesPort.ts";
import { controlledMachineFiles } from "./MachinePathControlledFiles.ts";
import {
  bashModule,
  machinePathFixture,
  type MachinePathFixtureOptions,
} from "./MachinePathFixture.ts";
import { writeUpperFile } from "./MachinePathFixtureSupport.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const file =
  NodeProcess.env.SIGNALBOX_MACHINE_PATH_INVENTORY_FILE ??
  new URL("../../../infra/kernelPrograms/machine-files/build/runner.json", import.meta.url);
if (NodeProcess.env.SIGNALBOX_MACHINE_PATH_INVENTORY_FILE !== undefined && !NodeFS.existsSync(file))
  throw new Error("Required machine inventory is missing");
const bytes = NodeFS.existsSync(file) ? NodeFS.readFileSync(file) : undefined;
if (
  bytes !== undefined &&
  NodeCrypto.createHash("sha256").update(bytes).digest("hex") !==
    "74186335378f14ba82d2c7ac3dfe3d2708b2b8f4f4b5faf9c009f23127ec4e19"
)
  throw new Error("Live symlink regression requires the frozen machine inventory");
const inventory: MachineProgramInventory | undefined =
  bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8"));

describe.skipIf(bashModule === undefined || inventory === undefined)(
  "ProductComputer live machine symlink traversal",
  () => {
    it.each(["dirty", "unattested"])(
      "finds the bare relative final symlink through live %s lookup",
      async (state) => {
        const { raw, files } = liveFiles(state);
        await withFixture(
          { inventory: inventory!, files, before: seedCatalog },
          async (fixture) => {
            const writes = fixture.sqlWriteCount();
            const result = await fixture.run("command -v py3versions; py3versions", "/bin");
            expect(
              result.status.exitCode,
              JSON.stringify({ result, calls: fixture.machineCalls }),
            ).toBe(23);
            expect(result.stdout).toBe("/bin/py3versions\n");
            expect(result.stderr).toBe("");
            expect(
              fixture.machineCalls.map(({ executable, argv }) => ({ executable, argv })),
            ).toEqual([{ executable: "/bin/py3versions", argv: ["py3versions"] }]);
            expect(fixture.sqlWriteCount()).toBe(writes);
            expect(raw.calls.length).toBeGreaterThan(0);
            expect(
              raw.calls.every(({ operations }) => operations.length > 0 && operations.length <= 64),
            ).toBe(true);
            const lookups = raw.calls.length;
            const repeated = await fixture.run("command -v py3versions; py3versions", "/bin");
            expect(repeated).toEqual(result);
            expect(raw.calls.length).toBeGreaterThan(lookups);
            expect(fixture.machineCalls).toHaveLength(2);
            expect(files.current().pristine).toBe(false);
            expect(fixture.sqlWriteCount()).toBe(writes);
          },
        );
      },
    );

    it.each(["dirty", "unattested"])(
      "uses live directory-produced symlinks on the %s machine",
      async (state) => {
        const { raw, files } = liveFiles(state);
        await withFixture(
          { inventory: inventory!, files, before: seedCatalog },
          async (fixture) => {
            const result = await fixture.run(
              "printf '%s\\n' /bin/py3v*; command -v py3versions; py3versions",
              "/bin",
            );
            expect(
              result.status.exitCode,
              JSON.stringify({ result, calls: fixture.machineCalls }),
            ).toBe(23);
            expect(result.stdout).toBe("/bin/py3versions\n/bin/py3versions\n");
            expect(result.stderr).toBe("");
            expect(
              fixture.machineCalls.map(({ executable, argv }) => ({ executable, argv })),
            ).toEqual([{ executable: "/bin/py3versions", argv: ["py3versions"] }]);
            expect(
              raw.calls.some(({ operations }) =>
                operations.some(
                  (operation) => operation.op === "readdir" && operation.path === "/bin",
                ),
              ),
            ).toBe(true);
            expect(raw.calls.every(({ operations }) => operations.length <= 64)).toBe(true);
          },
        );
      },
    );

    it.each(["dirty", "unattested"])(
      "preserves raw metadata/readlink and upper target precedence after %s lookup",
      async (state) => {
        const { files } = liveFiles(state);
        await withFixture(
          {
            inventory: inventory!,
            files,
            before(filesystem) {
              seedCatalog(filesystem);
              writeUpperFile(
                filesystem,
                "/usr/share/python3/py3versions.py",
                "printf UPPER_LIVE\n",
              );
            },
          },
          async (fixture) => {
            const captured = inventory!.entries.find(
              ({ path }) => path === "/usr/bin/py3versions",
            )!;
            await fixture.filesystem.prepareLowerPaths(["/bin/py3versions"]);
            expect(fixture.filesystem.lstat("/bin/py3versions")).toMatchObject({
              type: "symlink",
              size: BigInt(captured.size),
              nlink: BigInt(captured.nlink),
              atimeNs: BigInt(captured.atimeNs),
              mtimeNs: BigInt(captured.mtimeNs),
              ctimeNs: BigInt(captured.ctimeNs),
              posix: { mode: captured.mode, uid: captured.uid, gid: captured.gid },
            });
            expect(fixture.filesystem.readlink("/bin/py3versions")).toBe(captured.target);
            const writes = fixture.sqlWriteCount();
            const result = await fixture.run("py3versions", "/bin");
            expect(result.status.exitCode).toBe(0);
            expect(result.stdout).toBe("UPPER_LIVE");
            expect(result.stderr).toBe("");
            expect(fixture.machineCalls).toEqual([]);
            expect(fixture.sqlWriteCount()).toBe(writes);
          },
        );
      },
    );

    it.each([
      { state: "dirty", failure: "missing" },
      { state: "dirty", failure: "transport" },
      { state: "unattested", failure: "missing" },
      { state: "unattested", failure: "transport" },
    ])(
      "keeps required ancestor $failure fatal on the $state public path",
      async ({ state, failure }) => {
        const live = liveFiles(state);
        let failedAncestor = false;
        const files: MachineFilesPort = {
          ...live.files,
          async lookup(input, signal) {
            if (
              input.operations.length === 1 &&
              input.operations[0]?.op === "lstat" &&
              input.operations[0].path === "/bin"
            ) {
              failedAncestor = true;
              if (failure === "transport")
                throw new Error("Controlled required ancestor backend failed");
              return {
                generation: input.generation,
                results: [
                  {
                    id: input.operations[0].id,
                    op: "lstat",
                    error: { code: "ENOENT", message: "Required ancestor disappeared" },
                  },
                ],
              };
            }
            return live.files.lookup(input, signal);
          },
        };
        await withFixture(
          { inventory: inventory!, files, before: seedCatalog },
          async (fixture) => {
            const writes = fixture.sqlWriteCount();
            await expect(
              fixture.direct("py3versions", ["py3versions"], "/bin"),
            ).rejects.toMatchObject({ name: "KernelFileSystemUnavailable" });
            expect(failedAncestor).toBe(true);
            expect(fixture.machineCalls).toEqual([]);
            expect(fixture.sqlWriteCount()).toBe(writes);
          },
        );
      },
    );
  },
);

function liveFiles(state: string) {
  const raw = controlledMachineFiles(inventory!);
  let pristine = state !== "dirty";
  const files: MachineFilesPort = {
    current: () => ({
      generation: 1,
      pristine,
      ...(state === "dirty" ? { imageDigest: inventory!.imageDigest } : {}),
    }),
    async markExecuted(generation) {
      await raw.files.markExecuted(generation);
      pristine = false;
    },
    lookup: (input, signal) => raw.files.lookup(input, signal),
  };
  return { raw, files };
}

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
      throw new AggregateError([failure, cleanup], "Live symlink assertions and cleanup failed");
    throw cleanup;
  }
  if (failure !== undefined) throw failure;
}
