import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import type { BaseLease } from "../Computer.ts";
import { MachineCreationError } from "../Machine.ts";
import {
  createMachineFixture,
  machineBefore,
  machineCommand,
  machineInputBytes,
  machineOutputBytes,
} from "./helpers/machineFixture.ts";

const stdinBytes = new Uint8Array([0, 255, 42, 0]);

async function readBytes(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function indexOf(events: readonly string[], event: string) {
  const index = events.indexOf(event);
  expect(index, `missing event ${event}: ${events.join(", ")}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("MachineCommands", () => {
  it("captures the admitted command and brackets one cold execution through live apply", async () => {
    let resumeCheckpoint: ((at: typeof machineBefore) => void) | undefined;
    let checkpointEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      checkpointEntered = resolve;
    });
    const fixture = createMachineFixture({
      checkpoint: async () => {
        checkpointEntered();
        return new Promise((resolve) => {
          resumeCheckpoint = resolve;
        });
      },
    });
    const callerCommand = {
      executable: machineCommand.executable,
      argv: [...machineCommand.argv],
      cwd: machineCommand.cwd,
      env: { ...machineCommand.env },
    };
    const callerSignal = new AbortController().signal;
    const spawning = fixture.commands.spawn(callerCommand, callerSignal);
    await entered;

    callerCommand.argv[0] = "changed-argv0";
    callerCommand.argv[2] = "rewritten args";
    callerCommand.cwd = "/elsewhere";
    callerCommand.env.TOKEN = "changed";
    resumeCheckpoint!(machineBefore);

    const child = await spawning;
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.spawnCalls[0]).toEqual(machineCommand);
    expect(fixture.spawnCalls[0]).not.toBe(callerCommand);
    expect(Object.isFrozen(fixture.spawnCalls[0])).toBe(true);
    expect(Object.isFrozen(fixture.spawnCalls[0]!.argv)).toBe(true);
    expect(Object.isFrozen(fixture.spawnCalls[0]!.env)).toBe(true);
    expect(fixture.hydratedBytes).toEqual([machineInputBytes]);
    expect(child.stdin).toBe(fixture.child.stdin);
    expect(child.stdout).toBe(fixture.child.stdout);
    expect(child.stderr).toBe(fixture.child.stderr);

    const writer = child.stdin.getWriter();
    await writer.write(stdinBytes);
    await writer.close();
    expect(fixture.stdinBytes).toEqual([stdinBytes]);
    expect([...(await readBytes(child.stdout))]).toEqual([0, 255, 8]);
    expect([...(await readBytes(child.stderr))]).toEqual([13, 0, 10]);
    fixture.closeChild();
    await expect(child.exited).resolves.toEqual({ exitCode: 0, signal: 0, coreDumped: false });

    const events = fixture.events;
    expect(Option.isNone(fixture.createCalls[0]!.base)).toBe(true);
    expect(fixture.createCalls[0]!.expiresAt).toBe(2_000_000_000_000);
    expect(fixture.memory.fetchCalls[0]).toMatchObject({
      at: machineBefore,
      paths: ["/workspace/source.bin"],
      status: "ok",
    });
    expect(indexOf(events, "journal:checkpoint")).toBeLessThan(indexOf(events, "checkpoint"));
    expect(indexOf(events, "checkpoint")).toBeLessThan(indexOf(events, "base.acquire"));
    expect(indexOf(events, "base.acquire")).toBeLessThan(indexOf(events, "journal:create"));
    expect(indexOf(events, "journal:create")).toBeLessThan(indexOf(events, "machine.create"));
    expect(indexOf(events, "machine.create")).toBeLessThan(indexOf(events, "prepare"));
    expect(indexOf(events, "hydrate")).toBeLessThan(indexOf(events, "attach"));
    expect(indexOf(events, "attach")).toBeLessThan(indexOf(events, "journal:execute"));
    expect(indexOf(events, "journal:execute")).toBeLessThan(indexOf(events, "spawn"));
    expect(indexOf(events, "child.closed")).toBeLessThan(indexOf(events, "child.dispose"));
    expect(indexOf(events, "child.dispose")).toBeLessThan(indexOf(events, "runtime.dispose"));
    expect(indexOf(events, "runtime.dispose")).toBeLessThan(indexOf(events, "file.commit"));
    expect(indexOf(events, "file.commit")).toBeLessThan(indexOf(events, "apply"));
    expect(indexOf(events, "apply")).toBeLessThan(indexOf(events, "machine.delete"));
    expect(indexOf(events, "machine.delete")).toBeLessThan(indexOf(events, "journal:complete"));
    expect(fixture.memory.committedTurns).toHaveLength(1);
    expect(fixture.memory.committedTurns[0]?.turnId).toBe("machine-op-1:after");
    const after = {
      ...machineBefore,
      commit: fixture.memory.committedTurns[0]!.receipt.commit,
    };
    expect([...fixture.memory.inspectTree(after)!["/workspace/result.bin"]!.data!]).toEqual([
      ...machineOutputBytes,
    ]);
    expect(fixture.appliedBytes).toEqual([machineOutputBytes]);
    expect(fixture.records.at(-1)?.phase).toBe("complete");
  });

  it("retries a failed commit under the same operation ids after caller cancellation", async () => {
    const base: BaseLease = {
      id: "warm-base",
      sourceRef: "recipe:snapshot",
      expiresAt: 1_900_000_000_000,
    };
    const fixture = createMachineFixture({ baseLease: base, commitFailures: 1 });
    const caller = new AbortController();
    const child = await fixture.commands.spawn(machineCommand, caller.signal);
    caller.abort(new Error("caller stopped waiting"));
    fixture.closeChild();

    await expect(child.exited).rejects.toMatchObject({
      name: "MachineRevisionError",
      code: "IO_ERROR",
    });
    expect(fixture.events).not.toContain("machine.delete");
    expect(fixture.events).not.toContain("base.release");
    expect(fixture.commitAttempts).toEqual(["machine-op-1:after"]);

    await fixture.commands.recover("machine-op-1");

    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.createCalls).toHaveLength(1);
    expect(fixture.createCalls[0]?.expiresAt).toBe(base.expiresAt);
    expect(fixture.commitAttempts).toEqual(["machine-op-1:after", "machine-op-1:after"]);
    expect(fixture.memory.committedTurns).toHaveLength(1);
    expect(fixture.appliedBytes).toEqual([machineOutputBytes]);
    expect(fixture.events).not.toContain("changes:wrong-signal");
    expect(fixture.events).not.toContain("apply:wrong-signal");
    expect(indexOf(fixture.events, "machine.delete")).toBeLessThan(
      indexOf(fixture.events, "base.release"),
    );
    expect(fixture.records.at(-1)?.phase).toBe("complete");
  });

  it("retains the VM and Base while applying the committed revision is uncertain", async () => {
    const base: BaseLease = {
      id: "warm-base",
      sourceRef: "recipe:snapshot",
      expiresAt: 1_900_000_000_000,
    };
    let applyAttempts = 0;
    const appliedRevisions: string[] = [];
    const fixture = createMachineFixture({
      baseLease: base,
      apply: async ({ after }) => {
        appliedRevisions.push(after.commit);
        applyAttempts += 1;
        if (applyAttempts === 1) throw new Error("live filesystem apply result is unknown");
      },
    });
    const child = await fixture.commands.spawn(machineCommand, new AbortController().signal);
    fixture.closeChild();

    await expect(child.exited).rejects.toThrow("live filesystem apply result is unknown");
    expect(fixture.events).not.toContain("machine.delete");
    expect(fixture.events).not.toContain("base.release");
    expect(fixture.memory.committedTurns).toHaveLength(1);

    await fixture.commands.recover("machine-op-1");

    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.commitAttempts).toEqual(["machine-op-1:after"]);
    expect(appliedRevisions).toHaveLength(2);
    expect(appliedRevisions[0]).toBe(appliedRevisions[1]);
    expect(indexOf(fixture.events, "machine.delete")).toBeLessThan(
      indexOf(fixture.events, "base.release"),
    );
    expect(fixture.records.at(-1)?.phase).toBe("complete");
  });

  it("keeps the Base until a failed VM deletion is confirmed on recovery", async () => {
    const base: BaseLease = {
      id: "warm-base",
      sourceRef: "recipe:snapshot",
      expiresAt: 1_900_000_000_000,
    };
    let deleteAttempts = 0;
    const fixture = createMachineFixture({
      baseLease: base,
      deleteMachine: async () => {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("VM deletion is unconfirmed");
      },
    });
    const child = await fixture.commands.spawn(machineCommand, new AbortController().signal);
    fixture.closeChild();

    await expect(child.exited).rejects.toThrow("VM deletion is unconfirmed");
    expect(fixture.events).not.toContain("base.release");
    expect(fixture.records.at(-1)?.phase).toBe("delete");

    await fixture.commands.recover("machine-op-1");

    expect(deleteAttempts).toBe(2);
    expect(fixture.events.filter((event) => event === "base.release")).toHaveLength(1);
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.createCalls).toHaveLength(1);
    expect(fixture.commitAttempts).toEqual(["machine-op-1:after"]);
    expect(fixture.records.at(-1)?.phase).toBe("complete");
  });

  it("commits writes after a failed spawn is closed and never retries that command", async () => {
    const failure = new Error("Runner lost the spawn acknowledgement");
    let generationEnded = false;
    const fixture = createMachineFixture({
      runtimeDispose: async () => {
        generationEnded = true;
        fixture.events.push("generation.ended");
      },
      spawn: async (_command, _signal, current) => {
        current.markOutputWritten();
        throw failure;
      },
    });

    await expect(fixture.commands.spawn(machineCommand, new AbortController().signal)).rejects.toBe(
      failure,
    );

    expect(generationEnded).toBe(true);
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.createCalls).toHaveLength(1);
    expect(indexOf(fixture.events, "generation.ended")).toBeLessThan(
      indexOf(fixture.events, "changes"),
    );
    expect(indexOf(fixture.events, "changes")).toBeLessThan(indexOf(fixture.events, "file.commit"));
    expect(fixture.memory.committedTurns).toHaveLength(1);
    expect(fixture.appliedBytes).toEqual([machineOutputBytes]);
  });

  it("retains a partial result and Base until runtime confirms process closure", async () => {
    const base: BaseLease = {
      id: "warm-base",
      sourceRef: "recipe:snapshot",
      expiresAt: 1_900_000_000_000,
    };
    let disposeAttempts = 0;
    let fixture!: ReturnType<typeof createMachineFixture>;
    fixture = createMachineFixture({
      baseLease: base,
      runtimeDispose: async () => {
        disposeAttempts += 1;
        if (disposeAttempts === 1) throw new Error("Runner process closure is unknown");
        fixture.events.push("generation.ended");
      },
      spawn: async (_command, _signal, current) => {
        current.markOutputWritten();
        throw new Error("Runner lost the spawn acknowledgement");
      },
    });

    await expect(
      fixture.commands.spawn(machineCommand, new AbortController().signal),
    ).rejects.toMatchObject({ message: "Command failed and its workspace requires recovery" });
    expect(fixture.events).not.toContain("changes");
    expect(fixture.events).not.toContain("file.commit");
    expect(fixture.events).not.toContain("machine.delete");
    expect(fixture.events).not.toContain("base.release");

    await fixture.commands.recover("machine-op-1");

    expect(disposeAttempts).toBe(2);
    expect(indexOf(fixture.events, "generation.ended")).toBeLessThan(
      indexOf(fixture.events, "changes"),
    );
    expect(fixture.memory.committedTurns).toHaveLength(1);
    expect(fixture.appliedBytes).toEqual([machineOutputBytes]);
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(fixture.createCalls).toHaveLength(1);
    expect(indexOf(fixture.events, "machine.delete")).toBeLessThan(
      indexOf(fixture.events, "base.release"),
    );
  });

  it("retains the Base while create is unknown and reconciles without another provider create", async () => {
    const base: BaseLease = {
      id: "warm-base",
      sourceRef: "recipe:snapshot",
      expiresAt: 1_900_000_000_000,
    };
    const ambiguous = new MachineCreationError("unknown", "create result is unknown");
    const stillUnknown = new MachineCreationError("unknown", "provider handle is not visible yet");
    let providerCreates = 0;
    let reserved: string | undefined;
    let adapterCalls = 0;
    const fixture = createMachineFixture({
      baseLease: base,
      createMachine: async (input, _signal, handle) => {
        if (adapterCalls === 0) {
          reserved = input.operationId;
          providerCreates += 1;
          adapterCalls += 1;
          throw ambiguous;
        }
        expect(input.operationId).toBe(reserved);
        adapterCalls += 1;
        if (adapterCalls === 2) throw stillUnknown;
        return handle;
      },
    });

    await expect(
      fixture.commands.spawn(machineCommand, new AbortController().signal),
    ).rejects.toMatchObject({ message: "Command failed and its workspace requires recovery" });

    expect(providerCreates).toBe(1);
    expect(fixture.createCalls).toHaveLength(2);
    expect(fixture.createCalls.map((input) => input.operationId)).toEqual([
      "machine-op-1",
      "machine-op-1",
    ]);
    expect(fixture.spawnCalls).toHaveLength(0);
    expect(fixture.events).not.toContain("machine.delete");
    expect(fixture.events).not.toContain("base.release");

    await fixture.commands.recover("machine-op-1");

    expect(adapterCalls).toBe(3);
    expect(providerCreates).toBe(1);
    expect(fixture.createCalls.map((input) => input.operationId)).toEqual([
      "machine-op-1",
      "machine-op-1",
      "machine-op-1",
    ]);
    expect(fixture.spawnCalls).toHaveLength(0);
    expect(indexOf(fixture.events, "machine.delete")).toBeLessThan(
      indexOf(fixture.events, "base.release"),
    );
    expect(fixture.records.at(-1)?.phase).toBe("complete");
  });

  it("releases a Base after the adapter proves creation did not happen", async () => {
    const base: BaseLease = {
      id: "warm-base",
      sourceRef: "recipe:snapshot",
      expiresAt: 1_900_000_000_000,
    };
    const failure = new MachineCreationError("not_created", "provider rejected creation");
    const fixture = createMachineFixture({
      baseLease: base,
      createMachine: async () => {
        throw failure;
      },
    });

    await expect(fixture.commands.spawn(machineCommand, new AbortController().signal)).rejects.toBe(
      failure,
    );

    expect(fixture.createCalls).toHaveLength(1);
    expect(fixture.spawnCalls).toHaveLength(0);
    expect(fixture.events).not.toContain("machine.delete");
    expect(indexOf(fixture.events, "journal:delete")).toBeLessThan(
      indexOf(fixture.events, "base.release"),
    );
    expect(fixture.records.at(-1)?.phase).toBe("complete");
  });
});
