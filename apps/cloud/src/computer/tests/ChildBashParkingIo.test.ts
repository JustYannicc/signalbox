import { describe, expect, it, vi } from "vite-plus/test";
import { within } from "./ChildBashGatewayCommand.ts";
import type { ProcessSlotPressure } from "../ProcessSlots.ts";
import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../kernel/KernelSyscallPort.ts";
import {
  bashArtifactAvailable,
  createBashGateway,
  expectBoundedSlots,
  runBashScript,
} from "./ChildBashGatewayFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

function bashPipelineWriterScript(label: string, size: number) {
  return [
    `printf -v payload '%*s' ${size} ''`,
    `printf '%s' "$payload" | { IFS= read -N ${size} data; printf '%s' "\${#data}" > /workspace/gate/reader-${label}; }`,
    `printf 'writer:${label}:done\\n'`,
  ].join("; ");
}

describe.skipIf(!bashArtifactAvailable)("GNU Bash I/O parking through CommandGateway", () => {
  it("bounds real Asyncify Bash file writes to 1 MiB windows without losing bytes", async () => {
    const run = createBashGateway();
    const size = KERNEL_SYSCALL_MAX_IO_BYTES + 512 * 1024;
    try {
      const result = await runBashScript(
        run.fixture,
        `printf -v payload '%*s' ${size} ''; printf '%s' "$payload" > /workspace/gate/payload`,
      );
      expect(result).toEqual({
        stdout: "",
        stderr: "",
        status: { exitCode: 0, signal: 0, coreDumped: false },
      });
      expect(run.fixture.read("/workspace/gate/payload")).toBe(" ".repeat(size));

      const writes = run.forkTrace.filter(
        (event) => event.event === "syscall" && event.name === "fd_write",
      );
      expect(writes.length).toBeGreaterThan(1);
      expect(
        writes.every(
          (event) =>
            typeof event.transferOffset === "number" &&
            typeof event.transferLength === "number" &&
            event.transferLength <= KERNEL_SYSCALL_MAX_IO_BYTES,
        ),
      ).toBe(true);
    } finally {
      await run.fixture.close();
    }
  });

  it.each([1, 2])(
    "returns a blocked Bash pipe writer's RPC before a queued reader runs at cap %i",
    async (capacityLimit) => {
      const size = 2 * 65_536;
      const queuedPressure = Promise.withResolvers<ProcessSlotPressure>();
      const run = createBashGateway({
        capacityLimit,
        localForkPackingBytes: 0,
        async beforeRpcReturn({ pid, events }) {
          const blockedWriter = events.some(
            (event) =>
              event.pid === pid &&
              event.event === "operation-pending" &&
              event.name === "fd_write" &&
              typeof event.transferLength === "number" &&
              event.transferLength >= size,
          );
          if (!blockedWriter) return;
          const pressure = await within(queuedPressure.promise, 15_000);
          if (pressure.kind === "deadline")
            throw new Error(`Writer RPC held without capacity pressure for pid ${pid}`);
          if (pressure.kind === "rejected") throw pressure.error;
          run.forkTrace.push({
            event: "writer-rpc-release",
            pid,
            inFlight: pressure.value.inFlight,
            waiting: pressure.value.waiting,
          });
        },
      });
      const stopPressure = run.fixture.capacity.onPressure((pressure) => {
        run.forkTrace.push({ event: "capacity-pressure", ...pressure });
        if (
          pressure.kind === "capacity" &&
          pressure.inFlight === capacityLimit &&
          pressure.waiting > 0
        )
          queuedPressure.resolve(pressure);
      });
      const commands = Array.from({ length: capacityLimit }, (_, index) =>
        runBashScript(run.fixture, bashPipelineWriterScript(`job-${index}`, size)),
      );
      const traceTail = () =>
        JSON.stringify(
          run.forkTrace
            .filter((event) =>
              [
                "fork",
                "placeFork",
                "placeFork-return",
                "operation-pending",
                "capacity-pressure",
                "writer-rpc-release",
                "source-state",
                "stop-ack",
                "rpc-return",
                "worker-start",
                "restored",
              ].includes(String(event.event)),
            )
            .slice(-80),
          (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
        );
      try {
        const settled = await within(Promise.all(commands), 30_000);
        if (settled.kind === "deadline")
          throw new Error(`Bash pipe flow stalled; trace tail: ${traceTail()}`);
        if (settled.kind === "rejected") throw settled.error;
        const results = settled.value;
        await run.fixture.gateway.drain();
        expect(results.every((result) => result.stderr === "")).toBe(true);
        expect(results.every((result) => result.status.exitCode === 0)).toBe(true);
        for (let index = 0; index < capacityLimit; index++) {
          expect(run.fixture.read(`/workspace/gate/reader-job-${index}`)).toBe(String(size));
          expect(
            results.some((result) => result.stdout.includes(`writer:job-${index}:done\n`)),
          ).toBe(true);
        }

        const pendingWriters = run.forkTrace.filter(
          (event) =>
            event.event === "operation-pending" &&
            event.name === "fd_write" &&
            event.active === capacityLimit &&
            typeof event.transferLength === "number" &&
            event.transferLength >= size,
        );
        const writerByPid = new Map(pendingWriters.map((event) => [event.pid, event] as const));
        expect(
          writerByPid.size,
          `No fd_write blocked at full capacity; trace tail: ${traceTail()}`,
        ).toBeGreaterThanOrEqual(1);
        for (const writer of [...writerByPid.values()].slice(0, capacityLimit)) {
          const pid = writer.pid;
          const pendingAt = run.forkTrace.indexOf(writer);
          const stopAt = run.forkTrace.findIndex(
            (event, index) => index > pendingAt && event.event === "stop-ack" && event.pid === pid,
          );
          const stopped = run.forkTrace[stopAt];
          const returnAt = run.forkTrace.findIndex(
            (event, index) => index > stopAt && event.event === "rpc-return" && event.pid === pid,
          );
          expect(stopAt).toBeGreaterThan(pendingAt);
          expect(
            returnAt,
            `No RPC return after stop ACK; trace tail: ${traceTail()}`,
          ).toBeGreaterThan(stopAt);

          const writerFork = run.forkTrace.find(
            (event) => event.event === "fork" && event.childPid === pid,
          );
          const parentPid = writerFork?.pid;
          expect(parentPid).toBeDefined();
          const siblingPids = run.forkTrace
            .filter((event) => event.event === "fork" && event.pid === parentPid)
            .map((event) => event.childPid);
          const readerPid = siblingPids.find((candidate) =>
            run.forkTrace.some(
              (event) =>
                event.event === "syscall" && event.name === "fd_read" && event.pid === candidate,
            ),
          );
          expect(readerPid).toBeDefined();
          const placedReaderAt = run.forkTrace.findIndex(
            (event, index) =>
              index < returnAt && event.event === "placeFork-return" && event.pid === readerPid,
          );
          expect(
            placedReaderAt,
            `Reader fork was not queued before writer RPC return; trace tail: ${traceTail()}`,
          ).toBeGreaterThanOrEqual(0);
          const pressureAt = run.forkTrace.findIndex(
            (event, index) =>
              index < returnAt &&
              event.event === "capacity-pressure" &&
              event.inFlight === capacityLimit &&
              Number(event.waiting) > 0,
          );
          expect(
            pressureAt,
            `Reader was not queued before writer RPC return; trace tail: ${traceTail()}`,
          ).toBeGreaterThanOrEqual(0);
          const resumedReadAt = run.forkTrace.findIndex(
            (event, index) =>
              index > returnAt && event.event === "worker-start" && event.pid === readerPid,
          );
          expect(
            resumedReadAt,
            `Reader did not acquire after writer return; trace tail: ${traceTail()}`,
          ).toBeGreaterThan(returnAt);
          expect(
            run.forkTrace.some(
              (event, index) =>
                index > resumedReadAt &&
                event.event === "syscall" &&
                event.name === "fd_read" &&
                event.pid === readerPid,
            ),
          ).toBe(true);
          const sourceAt = run.forkTrace.findIndex(
            (event, index) =>
              index > pendingAt && event.event === "source-state" && event.pid === pid,
          );
          expect(sourceAt).toBeGreaterThan(pendingAt);
          expect(sourceAt).toBeLessThan(stopAt);
          expect(run.forkTrace[sourceAt]).toMatchObject({
            operationName: "fd_write",
            memoryBytes: expect.any(Number),
          });
          expect(run.forkTrace[sourceAt]?.memoryBytes).toBeGreaterThan(65_536);
          const restoreAt = run.forkTrace.findIndex(
            (event, index) => index > returnAt && event.event === "restored" && event.pid === pid,
          );
          expect(restoreAt).toBeGreaterThan(returnAt);
          expect(
            run.forkTrace.some(
              (event, index) =>
                index > returnAt && event.event === "worker-start" && event.pid === pid,
            ),
          ).toBe(true);
        }
        expectBoundedSlots(run, run.fixture.capacity.residentByteLimit, capacityLimit);
      } finally {
        stopPressure();
        run.fixture.controller.abort();
        await Promise.allSettled(commands);
        await run.fixture.close();
      }
    },
    90_000,
  );
});
