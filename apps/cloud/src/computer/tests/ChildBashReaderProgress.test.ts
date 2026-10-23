import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelHandle } from "../../kernel/KernelAbi.ts";
import { bashArtifactAvailable, createBashGateway } from "./ChildBashGatewayFixture.ts";
import {
  captureText,
  cleanupGatewayCommand,
  publicCommand,
  within,
  withFailurePreservingCleanup,
} from "./ChildBashGatewayCommand.ts";
import { childBashFixture, exited } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const readerScript =
  'coproc FEED { while read -r l; do echo "$l"; done; }; exec 5<&${FEED[0]} 6>&${FEED[1]}; for i in {1..160}; do ( read -r x <&5; y=$(echo "$x"); : "$y" ) & done; echo forked >&2; for i in {1..160}; do echo $i; done >&6; exec 6>&- 5<&-; eval "exec ${FEED[1]}>&-"; wait; echo done';

function observeProcessTable(gateway: ReturnType<typeof createBashGateway>) {
  const processes = gateway.fixture.context.processes;
  const originalSpawn = processes.spawn.bind(processes);
  const originalWaitpid = processes.waitpid.bind(processes);
  vi.spyOn(processes, "spawn").mockImplementation((parent, launch, release, options) => {
    const parentInfo = processes.info(parent);
    const result = originalSpawn(parent, launch, release, options);
    gateway.forkTrace.push({
      event: result.status === "ok" ? "table-spawn" : "table-spawn-error",
      pid: result.status === "ok" ? result.value.pid : undefined,
      parentPid: parentInfo.status === "ok" ? parentInfo.value.pid : undefined,
      processCount: processes.size,
      error: result.status === "error" ? result.error.code : undefined,
    });
    return result;
  });
  vi.spyOn(processes, "waitpid").mockImplementation((parent, selector, options = 0) => {
    const parentInfo = processes.info(parent);
    const result = originalWaitpid(parent, selector, options);
    const pid = result.status === "ok" && result.value.pid > 0 ? result.value.pid : undefined;
    gateway.forkTrace.push({
      event: "table-waitpid",
      parentPid: parentInfo.status === "ok" ? parentInfo.value.pid : undefined,
      selector,
      result: result.status,
      pid,
      reaped: pid !== undefined && processes.lookupPid(pid).status === "error",
      processCount: processes.size,
    });
    return result;
  });
}

function lifecycleSnapshot(gateway: ReturnType<typeof createBashGateway>) {
  const trace = gateway.forkTrace;
  const parentByPid = new Map<number, number>();
  const spawns = trace.filter((event) => event.event === "table-spawn");
  for (const event of spawns) {
    if (typeof event.pid === "number" && typeof event.parentPid === "number")
      parentByPid.set(event.pid, event.parentPid);
  }
  const rootPid = trace.find(
    (event) => event.event === "worker-start" && event.command === readerScript,
  )?.pid;
  const rootChildren =
    typeof rootPid === "number"
      ? spawns
          .filter((event) => event.parentPid === rootPid)
          .map((event) => event.pid)
          .filter((pid): pid is number => typeof pid === "number")
      : [];
  const rootReaps = trace
    .filter(
      (event) =>
        event.event === "table-waitpid" &&
        event.parentPid === rootPid &&
        event.result === "ok" &&
        event.reaped === true,
    )
    .map((event) => event.pid)
    .filter((pid): pid is number => typeof pid === "number");
  const rootChildStates = rootChildren.map((pid) => {
    const process = gateway.fixture.context.processes.lookupPid(pid);
    return process.status === "ok" ? process.value.status : "reaped";
  });
  const rootChildStateCounts = rootChildStates.reduce<Record<string, number>>((counts, state) => {
    counts[state] = (counts[state] ?? 0) + 1;
    return counts;
  }, {});
  const pendingReads = trace.filter(
    (event) => event.event === "operation-pending" && event.name === "fd_read",
  );
  const completed = trace
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.event === "complete");
  const completedWhileParentReadWasParked = completed.flatMap(({ event, index }) => {
    if (typeof event.pid !== "number") return [];
    const parentPid = parentByPid.get(event.pid);
    if (parentPid === undefined) return [];
    const pendingRead = trace.findIndex(
      (candidate) =>
        candidate.event === "operation-pending" &&
        candidate.name === "fd_read" &&
        candidate.pid === parentPid,
    );
    if (pendingRead < 0 || pendingRead >= index) return [];
    const resumed = trace
      .slice(pendingRead + 1, index)
      .some((candidate) => candidate.event === "worker-start" && candidate.pid === parentPid);
    return resumed ? [] : [{ childPid: event.pid, parentPid }];
  });
  const waits = trace.filter((event) => event.event === "table-waitpid");
  const rootWaits = waits.filter((event) => event.parentPid === rootPid);
  const spawnErrors = trace.filter((event) => event.event === "table-spawn-error");
  const forkErrors = trace.filter((event) => event.event === "fork" && event.errno !== undefined);
  return {
    rootPid,
    rootChildren: rootChildren.length,
    rootReaps: rootReaps.length,
    allRootChildrenReaped: rootChildren.every((pid) => rootReaps.includes(pid)),
    rootChildStateCounts,
    rootExitedChildren: rootChildren
      .filter((pid) => gateway.fixture.context.processes.lookupPid(pid).status === "ok")
      .filter((pid) => {
        const process = gateway.fixture.context.processes.lookupPid(pid);
        return process.status === "ok" && process.value.status === "exited";
      })
      .slice(0, 8),
    processCount: gateway.fixture.context.processes.size,
    peakProcesses: Math.max(0, ...spawns.map((event) => Number(event.processCount ?? 0))),
    forkErrors: forkErrors.length,
    spawnErrorsByParent: Object.entries(
      spawnErrors.reduce<Record<string, number>>((counts, event) => {
        const parent = String(event.parentPid);
        counts[parent] = (counts[parent] ?? 0) + 1;
        return counts;
      }, {}),
    )
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8),
    pendingReadPids: [...new Set(pendingReads.map((event) => event.pid))].slice(0, 12),
    completedWhileParentReadWasParked: completedWhileParentReadWasParked.slice(0, 12),
    waitpid: {
      calls: waits.length,
      blocked: waits.filter((event) => event.result === "would_block").length,
      reaped: waits.filter((event) => event.reaped === true).length,
      rootCalls: rootWaits.length,
      rootBlocked: rootWaits.filter((event) => event.result === "would_block").length,
      rootReaped: rootWaits.filter((event) => event.reaped === true).map((event) => event.pid),
      tail: waits.slice(-12),
    },
  };
}

describe.skipIf(!bashArtifactAvailable)("public Bash reader progress", () => {
  it("reaps command-substitution children while all 160 public pipe readers make progress", async () => {
    const gateway = createBashGateway();
    const commandController = new AbortController();
    observeProcessTable(gateway);
    let child: Awaited<ReturnType<typeof publicCommand>> | undefined;
    let commandSettled = false;
    await withFailurePreservingCleanup(
      async () => {
        child = await publicCommand(gateway, readerScript, commandController.signal);
        const stdout = captureText(child.stdout);
        const stderr = captureText(child.stderr);
        const result = await within(
          Promise.all([stdout.settled, stderr.settled, child.exited]),
          15_000,
        );
        commandSettled = result.kind === "completed";
        const lifecycle = lifecycleSnapshot(gateway);
        const message = `reader lifecycle: ${JSON.stringify(lifecycle)}; stderr: ${stderr.text()}; stdout: ${stdout.text()}`;
        expect(result.kind, message).toBe("completed");
        if (result.kind === "completed") {
          const [, , status] = result.value;
          expect(status, message).toEqual(exited());
          expect(stderr.text(), message).toContain("forked\n");
          expect(stderr.text(), message).not.toContain("Resource temporarily unavailable");
          expect(stdout.text(), message).toBe("done\n");
          expect(lifecycle.peakProcesses, message).toBeLessThanOrEqual(256);
          expect(lifecycle.forkErrors, message).toBe(0);
          expect(lifecycle.allRootChildrenReaped, message).toBe(true);
        }
      },
      async (bodyFailed) => {
        try {
          await cleanupGatewayCommand(
            gateway,
            child,
            commandController,
            bodyFailed || !commandSettled,
          );
        } finally {
          vi.restoreAllMocks();
        }
      },
    );
  }, 30_000);
});

async function waitForChildExit(
  fixture: ReturnType<typeof childBashFixture>,
  handle: KernelHandle<"process">,
) {
  for (;;) {
    const result = fixture.processes.exitStatus(handle);
    if (result.status === "ok") return result.value;
    if (result.status === "error") throw new Error(result.error.message);
    try {
      const woke = await fixture.wakes.wait(result.wakeToken, fixture.controller.signal);
      if (woke.status !== "ok") throw new Error("Process exit wait was interrupted");
    } finally {
      fixture.wakes.release(result.wakeToken);
    }
  }
}

it("preserves an opportunistically reaped wait status and leaves it after invalid flags", async () => {
  const fixture = childBashFixture();
  try {
    const first = await fixture.owner.port.fork();
    expect(first.kind).toBe("fork");
    if (first.kind !== "fork") return;

    const expectedStatus = exited(23);
    await first.port.complete({ kind: "exit", status: expectedStatus });
    const firstProcess = fixture.processes.lookupPid(first.pid);
    expect(firstProcess.status).toBe("ok");
    if (firstProcess.status !== "ok") return;
    await expect(waitForChildExit(fixture, firstProcess.value.handle)).resolves.toEqual(
      expectedStatus,
    );

    const second = await fixture.owner.port.fork();
    expect(second.kind).toBe("fork");
    if (second.kind !== "fork") return;
    expect(fixture.processes.lookupPid(first.pid).status).toBe("error");

    await second.port.complete({ kind: "exit", status: exited() });
    await expect(fixture.owner.port.wait(first.pid, 2)).resolves.toEqual({
      kind: "error",
      errno: 28,
    });
    await expect(fixture.owner.port.wait(first.pid, 0)).resolves.toEqual({
      kind: "wait",
      pid: first.pid,
      status: expectedStatus,
    });
    await expect(fixture.owner.port.wait(first.pid, 0)).resolves.toMatchObject({
      kind: "error",
      errno: 12,
    });
  } finally {
    await fixture.close();
  }
});
