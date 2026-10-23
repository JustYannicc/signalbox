import { describe, expect, it, vi } from "vite-plus/test";
import { KernelFileSystemUnavailable } from "../../kernel/KernelLowerFileSystem.ts";
import { MachineFileLookupError, type MachineFilesPort } from "../MachineFilesPort.ts";
import { bashModule, machinePathFixture, machinePathInventory } from "./MachinePathFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe.skipIf(bashModule === undefined)("ProductComputer machine lookup failures", () => {
  it("fails closed when an old runner lacks machine file lookup", async () => {
    const files: MachineFilesPort = {
      current: () => ({ generation: 1, pristine: false }),
      markExecuted: async () => {},
      lookup: async () => {
        throw new MachineFileLookupError(
          "BACKEND_UPGRADE_REQUIRED",
          "This Runner does not support machine file lookup.",
        );
      },
    };
    const fixture = machinePathFixture(bashModule!, { files });
    await withLookupFailureFixture(fixture, async () => {
      const visibleFailure = await expectUnavailableRejection(fixture.run("sort"));
      expect(fixture.machineCalls).toEqual([]);
      return visibleFailure;
    });
  });

  it("does not turn a Runner disconnect into command-not-found", async () => {
    const lookupCalls: string[] = [];
    const files: MachineFilesPort = {
      current: () => ({ generation: 1, pristine: false }),
      markExecuted: async () => {},
      lookup: async (input) => {
        lookupCalls.push(...input.operations.map((operation) => operation.op));
        throw new MachineFileLookupError("RUNNER_DISCONNECTED", "Runner disconnected.");
      },
    };
    const fixture = machinePathFixture(bashModule!, { files });
    await withLookupFailureFixture(fixture, async () => {
      const visibleFailure = await expectUnavailableRejection(fixture.run("sort"));
      expect(lookupCalls).toContain("lstat");
      expect(fixture.machineCalls).toEqual([]);
      return visibleFailure;
    });
  });

  it("leaves SQL unchanged when the second machine metadata batch fails", async () => {
    const lookupCalls: number[] = [];
    let pristine = true;
    const files: MachineFilesPort = {
      current: () => ({
        generation: 1,
        pristine,
        ...(pristine ? { imageDigest: machinePathInventory.imageDigest } : {}),
      }),
      async markExecuted(generation) {
        if (generation !== 1) throw new Error("Controlled generation changed");
        pristine = false;
      },
      async lookup(input, signal) {
        signal.throwIfAborted();
        lookupCalls.push(input.operations.length);
        if (lookupCalls.length > 1)
          throw new MachineFileLookupError("RUNNER_DISCONNECTED", "Lookup stopped mid-batch.");
        return {
          generation: input.generation,
          results: input.operations.map((operation) => ({
            id: operation.id,
            op: operation.op,
            error: { code: "ENOENT", message: "Controlled path is absent." },
          })),
        };
      },
    };
    const fixture = machinePathFixture(bashModule!, { files });
    const path = Array.from({ length: 40 }, (_, index) => `/missing/${index}`).join(":");
    await withLookupFailureFixture(fixture, async () => {
      await fixture.direct("sort", ["sort"]);
      const machineCallsBeforeLookup = fixture.machineCalls.length;
      expect(machineCallsBeforeLookup).toBe(1);
      const writesBefore = fixture.sqlWriteCount();
      const visibleFailure = await expectUnavailableRejection(
        fixture.direct("signalbox_lookup_crash", ["signalbox_lookup_crash"], path),
      );
      expect(lookupCalls.length).toBeGreaterThan(1);
      expect(lookupCalls[0]).toBe(64);
      expect(fixture.sqlWriteCount()).toBe(writesBefore);
      expect(fixture.machineCalls).toHaveLength(machineCallsBeforeLookup);
      return visibleFailure;
    });
  });
});

async function expectUnavailableRejection(run: Promise<unknown>): Promise<Error> {
  let failure: unknown;
  try {
    await run;
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeDefined();
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("Machine lookup did not reject with an error");
  // Process-table failures expose IO_ERROR; drain retains the original transport failure.
  if (failure.message !== "Child process completion failed")
    expect(failure.message).toContain("The machine could not answer a filesystem lookup");
  return failure;
}

async function closeAfterExpectedLookupFailure(
  fixture: ReturnType<typeof machinePathFixture>,
  visibleFailure: Error,
) {
  try {
    await fixture.close();
  } catch (cleanupFailure) {
    const original = findUnavailableCause(cleanupFailure);
    expect(original).toBeDefined();
    if (original === undefined) throw cleanupFailure;
    expect(original.message).toContain("The machine could not answer a filesystem lookup");
    if (visibleFailure.message !== "Child process completion failed")
      expect(visibleFailure.message).toContain(original.message);
    expect(containsOnlyExpectedLookupFailure(cleanupFailure, original.message)).toBe(true);
  }
}

function findUnavailableCause(error: unknown): KernelFileSystemUnavailable | undefined {
  if (error instanceof KernelFileSystemUnavailable) return error;
  if (error instanceof AggregateError) {
    return error.errors
      .map(findUnavailableCause)
      .find((cause): cause is KernelFileSystemUnavailable => cause !== undefined);
  }
  return error instanceof Error ? findUnavailableCause(error.cause) : undefined;
}

function containsOnlyExpectedLookupFailure(error: unknown, message: string): boolean {
  if (error instanceof KernelFileSystemUnavailable)
    return error.name === "KernelFileSystemUnavailable" && error.message === message;
  if (error instanceof AggregateError)
    return (
      error.errors.length > 0 &&
      error.errors.every((cause) => containsOnlyExpectedLookupFailure(cause, message))
    );
  return (
    error instanceof Error &&
    error.cause !== undefined &&
    containsOnlyExpectedLookupFailure(error.cause, message)
  );
}

async function withLookupFailureFixture(
  fixture: ReturnType<typeof machinePathFixture>,
  assertions: () => Promise<Error>,
) {
  let visibleFailure: Error | undefined;
  let assertionFailure: unknown;
  try {
    visibleFailure = await assertions();
  } catch (error) {
    assertionFailure = error;
  }

  try {
    if (visibleFailure === undefined) await fixture.close();
    else await closeAfterExpectedLookupFailure(fixture, visibleFailure);
  } catch (cleanupFailure) {
    if (assertionFailure !== undefined) {
      throw new AggregateError(
        [assertionFailure, cleanupFailure],
        "Machine lookup assertions and fixture cleanup both failed",
        { cause: cleanupFailure },
      );
    }
    throw cleanupFailure;
  }
  if (assertionFailure !== undefined) throw assertionFailure;
}
