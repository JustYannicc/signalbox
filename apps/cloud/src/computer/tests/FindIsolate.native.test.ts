// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Uses hash-pinned local WASM in a local Worker.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { startFindFixture } from "./FindIsolateFixture.ts";

const programDir = NodeProcess.env.SIGNALBOX_FIND_PROGRAM_DIR;
const artifactAvailable =
  programDir !== undefined &&
  NodeFS.existsSync(NodePath.join(programDir, "bash.wasm")) &&
  NodeFS.existsSync(NodePath.join(programDir, "busybox.wasm"));
if (programDir !== undefined && !artifactAvailable)
  throw new Error("Configured find test artifacts are incomplete");
if (NodeProcess.env.SIGNALBOX_REQUIRE_FIND_ARTIFACT === "1" && !artifactAvailable)
  throw new Error("SIGNALBOX_REQUIRE_FIND_ARTIFACT=1 requires pinned Bash and BusyBox artifacts");
const testRoot = NodeProcess.env.SIGNALBOX_FIND_TEST_ROOT;
if (artifactAvailable && testRoot === undefined)
  throw new Error("SIGNALBOX_FIND_TEST_ROOT is required when pinned artifacts are configured");

describe.skipIf(!artifactAvailable)("ProductComputer isolate find without a machine", () => {
  let fixture: Awaited<ReturnType<typeof startFindFixture>> | undefined;

  beforeAll(async () => {
    fixture = await startFindFixture(programDir!, testRoot!);
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("runs find nested -type f | head -50 through isolate lookup", async () => {
    const response = await fetch(fixture!.endpoint);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      command: {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        error?: { name: string; message: string; code?: string };
      };
      machine: {
        generationAbsent: boolean;
        generation: number | null;
        pristine: boolean;
        spawns: readonly string[];
        lookups: number;
      };
      processCount: number;
    };
    const paths = result.command.stdout?.trimEnd().split("\n") ?? [];
    expect(result.command, JSON.stringify(result.command)).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(paths.toSorted()).toEqual([
      "nested/entry.txt",
      "nested/sub/deeper/entry.txt",
      "nested/sub/entry.txt",
    ]);
    expect(result.machine).toEqual({
      generationAbsent: true,
      generation: null,
      pristine: false,
      spawns: [],
      lookups: 0,
    });
    expect(result.processCount).toBe(0);
  });
});
