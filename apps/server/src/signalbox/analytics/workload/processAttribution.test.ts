import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  containingDirectory,
  makeProcessAttribution,
  processKey,
  type AttributionTurn,
  type ProcessSample,
} from "./processAttribution.ts";

const SERVER = 100;
const A = ThreadId.make("a");
const B = ThreadId.make("b");
const RUN_A: AttributionTurn = { threadId: A, directory: "/wt/a", requestedAtMs: 10_000 };
const RUN_B: AttributionTurn = { threadId: B, directory: "/wt/b", requestedAtMs: 10_000 };

const proc = (
  pid: number,
  ppid: number,
  cpuTimeMs: number,
  options: { startTimeMs?: number; residentBytes?: number; name?: string } = {},
): ProcessSample => ({
  pid,
  ppid,
  cpuTimeMs,
  name: options.name ?? "node",
  startTimeMs: options.startTimeMs ?? 10_500,
  residentBytes: options.residentBytes ?? 1_000,
});

const cwds = (entries: ReadonlyArray<readonly [ProcessSample, string]>) => {
  const map = new Map(entries.map(([process, cwd]) => [processKey(process), cwd]));
  return (key: string) => map.get(key);
};

describe("containingDirectory", () => {
  it("picks the most specific directory and respects path boundaries", () => {
    const directories = ["/repo", "/repo/packages/a", "/worktrees/b"];
    expect(containingDirectory("/repo/packages/a/src", directories)).toBe("/repo/packages/a");
    expect(containingDirectory("/repo", directories)).toBe("/repo");
    expect(containingDirectory("/repository", directories)).toBeUndefined();
  });
});

describe("makeProcessAttribution", () => {
  it("charges a harness and its commands to the thread whose run spawned it", () => {
    const attribution = makeProcessAttribution(SERVER);
    const claude = proc(200, SERVER, 1_000, { residentBytes: 300 });
    const build = proc(201, 200, 0, { startTimeMs: 15_000, residentBytes: 700 });
    const other = proc(300, SERVER, 5_000, { residentBytes: 50 });
    const cwdOf = cwds([
      [claude, "/wt/a"],
      [build, "/wt/a/apps/web"],
      [other, "/wt/b"],
    ]);

    attribution.sample({
      sampledAtMs: 12_000,
      processes: [claude, other],
      turns: [RUN_A, RUN_B],
      cwdOf,
    });
    const usage = attribution.sample({
      sampledAtMs: 20_000,
      processes: [
        { ...claude, cpuTimeMs: 1_400 },
        { ...build, cpuTimeMs: 2_000 },
        { ...other, cpuTimeMs: 9_000 },
      ],
      turns: [RUN_A, RUN_B],
      cwdOf,
    });

    // 400 ms from the harness plus all 2 s of the build that started since.
    expect(usage.get(A)).toEqual({ cpuMs: 2_400, residentBytes: 1_000 });
    expect(usage.get(B)).toEqual({ cpuMs: 4_000, residentBytes: 50 });
  });

  it("ignores another thread's idle harness in the same directory", () => {
    const attribution = makeProcessAttribution(SERVER);
    const idle = proc(200, SERVER, 1_000, { startTimeMs: 1_000, residentBytes: 400 });
    const fresh = proc(300, SERVER, 1_000, { residentBytes: 200 });
    const shared = { ...RUN_B, directory: "/wt/a" };
    const usage = attribution.sample({
      sampledAtMs: 12_000,
      processes: [idle, fresh],
      turns: [shared],
      cwdOf: cwds([
        [idle, "/wt/a"],
        [fresh, "/wt/a"],
      ]),
    });
    expect(usage.get(B)?.residentBytes).toBe(200);
  });

  it("lets commands pick the thread of a harness that runs outside every directory", () => {
    const attribution = makeProcessAttribution(SERVER);
    const appServer = proc(200, SERVER, 1_000, { residentBytes: 400 });
    const shell = proc(201, 200, 100);
    const both = [RUN_A, RUN_B];

    const beforeCommand = attribution.sample({
      sampledAtMs: 12_000,
      processes: [appServer],
      turns: both,
      cwdOf: cwds([[appServer, "/srv"]]),
    });
    expect(beforeCommand.size).toBe(0);

    const withCommand = attribution.sample({
      sampledAtMs: 14_000,
      processes: [{ ...appServer, cpuTimeMs: 1_500 }, shell],
      turns: both,
      cwdOf: cwds([
        [appServer, "/srv"],
        [shell, "/wt/b"],
      ]),
    });
    expect(withCommand.get(B)).toEqual({ cpuMs: 500, residentBytes: 1_400 });

    // The claim outlives the command and the run, for the thread's next turn.
    const nextTurn = attribution.sample({
      sampledAtMs: 30_000,
      processes: [{ ...appServer, cpuTimeMs: 1_800 }],
      turns: [{ ...RUN_B, requestedAtMs: 25_000 }],
      cwdOf: cwds([[appServer, "/srv"]]),
    });
    expect(nextTurn.get(B)).toEqual({ cpuMs: 300, residentBytes: 400 });
  });

  it("charges nobody when two threads start in one checkout at once", () => {
    const attribution = makeProcessAttribution(SERVER);
    const harness = proc(200, SERVER, 0);
    const usage = attribution.sample({
      sampledAtMs: 12_000,
      processes: [harness],
      turns: [RUN_A, { ...RUN_B, directory: "/wt/a" }],
      cwdOf: cwds([[harness, "/wt/a"]]),
    });
    expect(usage.size).toBe(0);
  });

  it("never charges the resource monitor or CPU spent before it looked", () => {
    const attribution = makeProcessAttribution(SERVER);
    const monitor = proc(150, SERVER, 9_000, { name: "t3-resource-monitor" });
    const harness = proc(200, SERVER, 50_000);
    const usage = attribution.sample({
      sampledAtMs: 12_000,
      processes: [monitor, harness],
      turns: [RUN_A],
      cwdOf: () => "/wt/a",
    });
    expect(usage.get(A)).toEqual({ cpuMs: 0, residentBytes: 1_000 });
  });
});

describe("reset", () => {
  it("bills no CPU spent between runs", () => {
    const attribution = makeProcessAttribution(SERVER);
    const harness = proc(200, SERVER, 1_000);
    const cwdOf = cwds([[harness, "/wt/a"]]);
    attribution.sample({ sampledAtMs: 12_000, processes: [harness], turns: [RUN_A], cwdOf });
    attribution.reset();
    const nextRun = { ...RUN_A, requestedAtMs: 60_000 };
    const baseline = attribution.sample({
      sampledAtMs: 61_000,
      processes: [{ ...harness, cpuTimeMs: 4_000 }],
      turns: [nextRun],
      cwdOf,
    });
    expect(baseline.get(A)?.cpuMs).toBe(0);
    const later = attribution.sample({
      sampledAtMs: 66_000,
      processes: [{ ...harness, cpuTimeMs: 4_500 }],
      turns: [nextRun],
      cwdOf,
    });
    expect(later.get(A)?.cpuMs).toBe(500);
  });
});

describe("ownership evidence", () => {
  it("never hands an unrelated server child to the only run in flight", () => {
    const attribution = makeProcessAttribution(SERVER);
    const terminal = proc(200, SERVER, 0, { name: "zsh" });
    const shell = proc(201, 200, 0);
    const silentHarness = proc(300, SERVER, 0);
    const usage = attribution.sample({
      sampledAtMs: 12_000,
      processes: [terminal, shell, silentHarness],
      turns: [RUN_A],
      cwdOf: cwds([
        [terminal, "/other-project"],
        [shell, "/other-project/src"],
        [silentHarness, "/srv"],
      ]),
    });
    expect(usage.size).toBe(0);
  });
});
