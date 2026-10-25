// @effect-diagnostics nodeBuiltinImport:off - this local proof reads the captured inventory artifact.
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { coreutilsArtifactsAvailable, coreutilsModule } from "./CoreutilsArtifactFixture.ts";
import { bashModule, type MachinePathFixtureOptions } from "./MachinePathFixture.ts";
import { CHILD_PROGRAM_PATHS } from "../ChildProgramSet.ts";
import { machinePathDockerFixture } from "./MachinePathDockerFixture.ts";
import { writeUpperFile } from "./MachinePathFixtureSupport.ts";
import type { MachineProgramInventory } from "../MachineProgramInventory.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const dockerProofEnabled = NodeProcess.env.SIGNALBOX_MACHINE_PATH_DOCKER_PROOF === "1";
const inventoryPath = NodeProcess.env.SIGNALBOX_MACHINE_PATH_INVENTORY_FILE;
if (dockerProofEnabled && inventoryPath === undefined)
  throw new Error("Machine PATH Docker proof needs SIGNALBOX_MACHINE_PATH_INVENTORY_FILE");
if (dockerProofEnabled && bashModule === undefined)
  throw new Error("Machine PATH Docker proof needs the pinned Bash artifact");
if (dockerProofEnabled && !coreutilsArtifactsAvailable)
  throw new Error("Machine PATH Docker proof needs pinned coreutils artifacts");

const inventory =
  dockerProofEnabled && inventoryPath !== undefined
    ? (JSON.parse(NodeFS.readFileSync(inventoryPath, "utf8")) as MachineProgramInventory)
    : undefined;

const path = "/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin";

describe.skipIf(!dockerProofEnabled)("ProductComputer against the pinned Linux machine", () => {
  it.each(["pristine", "dirty", "unattested"])(
    "matches native execution of a relative final symlink beneath the upper catalog directory on the %s machine",
    (state) =>
      withLinuxMachine(
        async (fixture) => {
          if (state === "dirty") {
            const warmup = await fixture.direct("/usr/bin/jq", ["jq", "--version"], "/bin");
            expect(warmup.status.exitCode).toBe(0);
            expect(warmup.stderr).toBe("");
            expect(fixture.files.current().pristine).toBe(false);
          } else if (state === "unattested") {
            expect(fixture.files.current().imageDigest).toBeUndefined();
          }
          const command = "command -v py3versions; py3versions";
          const native = fixture.native("/bin/bash", ["--noprofile", "--norc", "-c", command], {
            PATH: "/bin",
            HOME: "/home/node",
            LC_ALL: "C",
          });
          expect(native.exitCode).not.toBe(127);
          expect(native.stdout.startsWith("/bin/py3versions\n")).toBe(true);
          const result = await fixture.run(command, "/bin");
          expect(result.status.exitCode).toBe(native.exitCode);
          expect(result.stdout).toBe(native.stdout);
          expect(result.stderr).toBe(native.stderr);
          expect(fixture.machineCalls).toContainEqual(
            expect.objectContaining({
              executable: "/bin/py3versions",
              argv: ["py3versions"],
            }),
          );
        },
        (filesystem) => {
          for (const path of Object.values(CHILD_PROGRAM_PATHS))
            writeUpperFile(filesystem, path, "");
        },
        state !== "unattested",
      ),
    120_000,
  );

  it(
    "runs native commands and both pipeline stages",
    () =>
      withLinuxMachine(async (fixture) => {
        for (const command of [
          "jq --version",
          "sort --version",
          "uniq --version",
          "wc --version",
          "awk 'BEGIN { print 17 }'",
          "xargs --version",
          "find --version",
        ]) {
          const result = await fixture.run(command, path);
          expect(result.status.exitCode, command).toBe(0);
          expect(result.stderr, command).toBe("");
        }

        const pipeline = await fixture.run('printf "b\\na\\nb\\n" | sort | uniq -c', path);
        expect(pipeline.status.exitCode).toBe(0);
        expect(pipeline.stdout).toBe("      1 a\n      2 b\n");
        expect(pipeline.stderr).toBe("");
      }),
    120_000,
  );

  it(
    "matches native predicates, metadata, and lazy file bytes",
    () =>
      withLinuxMachine(async (fixture) => {
        const shellPredicates = await fixture.run(
          '[ -f /usr/bin/sort ]; printf "file=%s\\n" "$?"; [ -x /usr/bin/sort ]; printf "x=%s\\n" "$?"',
          path,
        );
        expect(shellPredicates.stdout).toBe("file=0\nx=0\n");

        const nativeStatBare = fixture.native("/usr/bin/stat", ["--version"]);
        const computerStatBare = await fixture.run("stat --version", path);
        expect(computerStatBare.status.exitCode).toBe(nativeStatBare.exitCode);
        expect(computerStatBare.stdout).toBe(nativeStatBare.stdout);

        const nativeStat = fixture.native("/usr/bin/stat", ["-c", "%a %u %g %s", "/usr/bin/sort"], {
          LC_ALL: "C",
        });
        const computerStat = await fixture.run("stat -c '%a %u %g %s' /usr/bin/sort", path);
        expect(nativeStat.exitCode).toBe(0);
        expect(computerStat.status.exitCode).toBe(nativeStat.exitCode);
        expect(computerStat.stdout.trim()).toBe(nativeStat.stdout.trim());

        const lsArgs = ["-ln", "--time-style=+%Y-%m-%dT%H:%M:%S", "/usr/bin/sort"];
        const nativeLs = fixture.native("/usr/bin/ls", lsArgs, { LC_ALL: "C" });
        const computerLs = await fixture.run(`ls ${lsArgs.join(" ")}`, path);
        expect(nativeLs.exitCode).toBe(0);
        expect(computerLs.status.exitCode).toBe(0);
        expect(computerLs.stdout).toBe(nativeLs.stdout);

        const nativeBytes = fixture.native("/usr/bin/od", [
          "-An",
          "-tx1",
          "-N",
          "32",
          "/usr/bin/sort",
        ]);
        const computerBytes = await fixture.run("head -c 32 /usr/bin/sort | od -An -tx1", path);
        expect(nativeBytes.exitCode).toBe(0);
        expect(computerBytes.status.exitCode).toBe(0);
        expect(computerBytes.stdout.trim()).toBe(nativeBytes.stdout.trim());
      }),
    120_000,
  );

  it(
    "lets an upper script shadow a machine catalog alias",
    () =>
      withLinuxMachine(async (fixture) => {
        const aliasRun = await fixture.run(
          "/usr/bin/bash --noprofile --norc -c 'printf CATALOG'",
          path,
        );
        expect(aliasRun.status.exitCode).toBe(0);
        expect(aliasRun.stdout).toBe("USER_BASH_ALIAS");
        expect(aliasRun.stderr).toBe("");
      }),
    120_000,
  );

  it(
    "finds runtime installs in the same shell and later commands",
    () =>
      withLinuxMachine(async (fixture) => {
        const install =
          `python3 -c 'import os; os.makedirs("/home/node/.local/bin", exist_ok=True); ` +
          `p="/home/node/.local/bin/review_late"; ` +
          `open(p,"w").write("#!/bin/sh\\necho LATE_NATIVE\\n"); os.chmod(p,0o755)'`;
        const sameShell = await fixture.run(
          `${install}; command -v review_late; type -p review_late; hash review_late; hash -t review_late; hash -r; review_late`,
          path,
        );
        expect(sameShell.status.exitCode).toBe(0);
        expect(sameShell.stdout).toBe(
          "/home/node/.local/bin/review_late\n".repeat(3) + "LATE_NATIVE\n",
        );
        expect(fixture.files.current()).toEqual({ generation: 1, pristine: false });

        const laterCommand = await fixture.run("review_late", path);
        expect(laterCommand.status.exitCode).toBe(0);
        expect(laterCommand.stdout).toBe("LATE_NATIVE\n");
        const explicit = await fixture.run("/home/node/.local/bin/review_late", path);
        expect(explicit.status.exitCode).toBe(0);
        expect(explicit.stdout).toBe("LATE_NATIVE\n");

        const wrappers = await fixture.run(
          "command -v review_late; type -p review_late; hash review_late; hash -t review_late; which review_late; env review_late; hash -r; review_late",
          path,
        );
        expect(wrappers.status.exitCode).toBe(0);
        expect(wrappers.stderr).toBe("");
        expect(wrappers.stdout).toBe(
          "/home/node/.local/bin/review_late\n".repeat(4) + "LATE_NATIVE\nLATE_NATIVE\n",
        );
        expect(
          fixture.machineCalls.filter((call) => call.executable.endsWith("/review_late")).length,
        ).toBeGreaterThanOrEqual(4);
      }),
    120_000,
  );

  it(
    "executes a native program outside the image PATH",
    () =>
      withLinuxMachine(async (fixture) => {
        const outsidePath = await fixture.run(
          "command -v git-remote-https; git-remote-https",
          "/usr/lib/git-core",
        );
        const nativeOutsidePath = fixture.native(
          "/bin/bash",
          ["--noprofile", "--norc", "-c", "command -v git-remote-https; git-remote-https"],
          { PATH: "/usr/lib/git-core", HOME: "/home/node", LC_ALL: "C" },
        );
        expect(outsidePath.status.exitCode).toBe(nativeOutsidePath.exitCode);
        expect(outsidePath.stdout).toBe(nativeOutsidePath.stdout);
        expect(outsidePath.stderr).toBe(nativeOutsidePath.stderr);
        expect(
          fixture.machineCalls.some(
            (call) => call.executable === "/usr/lib/git-core/git-remote-https",
          ),
        ).toBe(true);
      }),
    120_000,
  );
});

async function withLinuxMachine(
  run: (fixture: Awaited<ReturnType<typeof machinePathDockerFixture>>) => Promise<void>,
  before?: MachinePathFixtureOptions["before"],
  attestImage = true,
) {
  const fixture = await machinePathDockerFixture({
    inventory: inventory!,
    bashModule: bashModule!,
    attestImage,
    options: {
      threadId: "machine-path-native-docker-proof",
      home: "/home/node",
      before:
        before ??
        ((filesystem) => {
          writeUpperFile(filesystem, "/usr/bin/bash", "printf USER_BASH_ALIAS\n");
        }),
      coreutilsModules: {
        head: coreutilsModule("head"),
        ls: coreutilsModule("ls"),
      },
    },
  });
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}
