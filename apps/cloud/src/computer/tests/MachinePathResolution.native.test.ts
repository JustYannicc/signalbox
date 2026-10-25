import { describe, expect, it, vi } from "vite-plus/test";
import { MachineFileLookupError, type MachineFilesPort } from "../MachineFilesPort.ts";
import { CHILD_PROGRAM_PATHS } from "../ChildProgramSet.ts";
import type { MachineProgramInventory } from "../MachineProgramInventory.ts";
import {
  bashModule,
  machinePathFixture,
  machinePathInventory,
  type MachinePathFixtureOptions,
} from "./MachinePathFixture.ts";
import { writeUpperFile } from "./MachinePathFixtureSupport.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const bin = machinePathInventory.entries.find((entry) => entry.path === "/bin")!;
const symlinkInventory: MachineProgramInventory = {
  ...machinePathInventory,
  entries: [
    ...machinePathInventory.entries.filter(
      (entry) => entry.path !== "/bin" && !entry.path.startsWith("/bin/"),
    ),
    { ...bin, type: "symlink" as const, target: "usr/bin", size: "7" },
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
};

describe.skipIf(bashModule === undefined)("ProductComputer ordered machine PATH resolution", () => {
  it("finds a pristine machine child below a symlink shadowed by the upper catalog directory", () =>
    withFixture(
      {
        inventory: symlinkInventory,
        before(filesystem) {
          for (const path of Object.values(CHILD_PROGRAM_PATHS))
            writeUpperFile(filesystem, path, "");
        },
      },
      async (fixture) => {
        expect(fixture.files.current().pristine).toBe(true);
        const result = await fixture.run("command -v sort; sort", "/bin");
        expect(
          result.status.exitCode,
          JSON.stringify({ result, calls: fixture.machineCalls }),
        ).toBe(23);
        expect(result.stdout).toBe("/bin/sort\n");
        expect(result.stderr).toBe("");
        expect(fixture.machineCalls.map(({ executable, argv }) => ({ executable, argv }))).toEqual([
          { executable: "/bin/sort", argv: ["sort"] },
        ]);
      },
    ));

  it("merges upper directory entries with the machine symlink directory during Bash globbing", () =>
    withFixture(
      {
        inventory: symlinkInventory,
        before: (filesystem) => writeUpperFile(filesystem, "/bin/upper-only", "printf UPPER\n"),
      },
      async (fixture) => {
        const result = await fixture.run("printf '%s\\n' /bin/*", "/bin");
        expect(result.status.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        const paths = result.stdout.trim().split("\n");
        expect(paths).toContain("/bin/sort");
        expect(paths).toContain("/bin/upper-only");
        expect(new Set(paths).size).toBe(paths.length);
        expect(fixture.machineCalls).toEqual([]);
      },
    ));

  it("keeps an upper executable ahead of children discovered through the machine symlink", () =>
    withFixture(
      {
        inventory: symlinkInventory,
        before: (filesystem) => writeUpperFile(filesystem, "/bin/sort", "printf UPPER_SORT\n"),
      },
      async (fixture) => {
        const result = await fixture.run("sort", "/bin");
        expect(result.status.exitCode).toBe(0);
        expect(result.stdout).toBe("UPPER_SORT");
        expect(result.stderr).toBe("");
        expect(fixture.machineCalls).toEqual([]);
      },
    ));

  it.each([
    { state: "dirty", entry: "Bash" },
    { state: "dirty", entry: "direct exec" },
    { state: "unattested", entry: "Bash" },
    { state: "unattested", entry: "direct exec" },
  ])(
    "resolves an earlier upper executable through $entry with a disconnected $state machine",
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
            for (const path of Object.values(CHILD_PROGRAM_PATHS))
              writeUpperFile(filesystem, path, "");
            // Bash probes its controlling terminal before it searches PATH.
            writeUpperFile(filesystem, "/dev/tty", "");
            writeUpperFile(filesystem, "/workspace/bin/tool", "printf UPPER\n");
          },
        },
        async (fixture) => {
          if (entry === "Bash") {
            const result = await fixture.direct(
              "/bin/bash",
              ["/bin/bash", "--noprofile", "--norc", "-c", "tool"],
              "/workspace/bin:/usr/bin",
            );
            expect(result.status.exitCode).toBe(0);
            expect(result.stdout).toBe("UPPER");
            expect(result.stderr).toBe("");
          } else {
            await expect(
              fixture.direct("tool", ["tool"], "/workspace/bin:/usr/bin"),
            ).rejects.toMatchObject({ code: "ENOEXEC" });
          }
          expect(lookups).toEqual([]);
          expect(fixture.machineCalls).toEqual([]);
        },
      );
    },
  );
});

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
      throw new AggregateError([failure, cleanup], "PATH assertions and cleanup failed");
    throw cleanup;
  }
  if (failure !== undefined) throw failure;
}
