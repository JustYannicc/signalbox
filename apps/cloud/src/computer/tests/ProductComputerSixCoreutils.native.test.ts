// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Optional native proof uses pinned local artifacts and a local Wrangler worker.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { startProductComputerSixCoreutilsFixture } from "./ProductComputerSixCoreutilsFixture.ts";

const configuredProgramDir = NodeProcess.env.SIGNALBOX_SIX_COREUTILS_PROGRAM_DIR;
const programDir = NodePath.resolve(
  configuredProgramDir ??
    NodePath.join(import.meta.dirname, "../../../../../.t3/issue-1255-coreutils-six/programs"),
);
const available = NodeFS.existsSync(programDir);
if (configuredProgramDir !== undefined && !available)
  throw new Error(`Required six-command test artifact directory is missing: ${programDir}`);

describe.skipIf(!available)("ProductComputer with pinned six-command artifacts", () => {
  let fixture: Awaited<ReturnType<typeof startProductComputerSixCoreutilsFixture>> | undefined;

  beforeAll(async () => {
    fixture = await startProductComputerSixCoreutilsFixture(programDir);
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("runs the six requested commands through ProductComputer without a machine", async () => {
    const response = await fetch(fixture!.endpoint);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      results: readonly {
        label: string;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        error?: { name: string; message: string; code?: string };
      }[];
      shadow: {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        error?: { name: string; message: string; code?: string };
      };
      processCount: number;
      machine: { generationAbsent: boolean; spawns: readonly unknown[]; lookups: number };
    };
    const byLabel = new Map(result.results.map((entry) => [entry.label, entry]));

    for (const entry of result.results) {
      expect(entry, `expected ${entry.label} to exit 0: ${JSON.stringify(entry)}`).toMatchObject({
        exitCode: 0,
        stderr: "",
      });
    }
    expect(byLabel.get("env PATH")?.stdout).toContain("SIGNALBOX_SIX=isolated");
    expect(byLabel.get("env absolute")?.stdout).toContain("SIGNALBOX_SIX=isolated");
    for (const label of ["id -u PATH", "id -u absolute"])
      expect(byLabel.get(label)?.stdout).toBe("1234\n");
    for (const label of ["id -g PATH", "id -g absolute"])
      expect(byLabel.get(label)?.stdout).toBe("5678\n");
    for (const label of ["id -un PATH", "id -un absolute"])
      expect(byLabel.get(label)?.stdout).toBe("signalbox\n");
    for (const label of ["id -gn PATH", "id -gn absolute"])
      expect(byLabel.get(label)?.stdout).toBe("agents\n");
    for (const label of ["wc -l PATH", "wc -l absolute"])
      expect(byLabel.get(label)?.stdout?.trim()).toBe("3 lines.txt");
    for (const label of ["sort PATH", "sort absolute"])
      expect(byLabel.get(label)?.stdout).toBe("a\nb\nc\n");
    for (const label of ["uniq PATH", "uniq absolute"])
      expect(byLabel.get(label)?.stdout).toBe("a\nb\n");
    for (const label of ["jq PATH", "jq absolute"]) {
      const output = byLabel.get(label)?.stdout;
      expect(output === undefined ? undefined : JSON.parse(output)).toEqual({ answer: 42 });
    }
    expect(result.shadow, JSON.stringify(result.shadow)).toMatchObject({
      exitCode: 0,
      stdout: "UPPER_PATH\n",
      stderr: "",
    });
    expect(result.processCount).toBe(0);
    expect(result.machine).toEqual({ generationAbsent: true, spawns: [], lookups: 0 });
  });
});
