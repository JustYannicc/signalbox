import { afterEach, describe, expect, it } from "@effect/vitest";
import { HarnessRunStoreError, readHarnessRunStoreProcessSource } from "../../HarnessRunStore.ts";
import { assertNoLegacyProcessResumeForSource, readLegacyProcessSource } from "../legacySource.ts";
import {
  createLegacyAdoptionFixture,
  createLegacyRunStoreFixture,
} from "./legacyProcessSource/HarnessLegacyProcessSource.fixture.ts";

const fixtures = new Set<ReturnType<typeof createLegacyRunStoreFixture>>();
afterEach(() => {
  for (const fixture of fixtures) fixture.close();
  fixtures.clear();
});

function fixture() {
  const value = createLegacyRunStoreFixture();
  fixtures.add(value);
  return value;
}

describe("legacy process source from RunStore", () => {
  it("returns the persisted current facet and completed request after authenticating both capabilities", async () => {
    const runStore = fixture();
    const expected = await runStore.completeSource();

    const source = readHarnessRunStoreProcessSource(runStore.database, expected.runId, {
      controlKey: expected.controlKey,
      supervisor: expected.supervisor,
    });

    expect(source).toEqual({
      runId: expected.runId,
      processOperationId: "legacy-source-process-operation",
      supervisor: expected.supervisor,
      currentPublisher: expected.publisher,
      request: expected.request,
      finish: expected.finish,
      parentCheckpoint: expected.parentCheckpoint,
    });
  });

  it.each([
    {
      controlKey: "wrong-controller-key-".repeat(2),
      supervisor: {
        epoch: 1,
        claimId: "legacy-source-supervisor-claim",
        supervisorKey: "legacy-source-supervisor-key-".repeat(2),
      },
    },
    {
      controlKey: "legacy-source-controller-key-".repeat(2),
      supervisor: {
        epoch: 1,
        claimId: "wrong-claim",
        supervisorKey: "legacy-source-supervisor-key-".repeat(2),
      },
    },
  ])("rejects an invalid controller or supervisor capability", async (auth) => {
    const runStore = fixture();
    const expected = await runStore.completeSource();

    expect(() => readHarnessRunStoreProcessSource(runStore.database, expected.runId, auth)).toThrow(
      expect.objectContaining({ code: "STALE_SUPERVISOR" }),
    );
  });

  it("rejects an older completed request when a later request is current", async () => {
    const runStore = fixture();
    const expected = await runStore.completeSource();
    await runStore.call({
      type: "request.offer",
      runId: expected.runId,
      supervisor: expected.supervisor,
      request: {
        requestId: "later-offer",
        input: { id: "later-input", sha256: "9".repeat(64), bytes: 4 },
      },
    });

    expect(() =>
      readHarnessRunStoreProcessSource(runStore.database, expected.runId, {
        controlKey: expected.controlKey,
        supervisor: expected.supervisor,
      }),
    ).toThrow(
      expect.objectContaining({ code: "CONFLICT" } satisfies Partial<HarnessRunStoreError>),
    );
  });
});

describe("legacy terminal adoption source", () => {
  it("returns durable source identity and the current adoption fence with exact receipt evidence", async () => {
    const fixture = await createLegacyAdoptionFixture();
    fixtures.add(fixture.runStore);

    const candidate = await readLegacyProcessSource({
      storage: fixture.storage,
      environment: fixture.environment,
      operation: fixture.operation,
      fence: fixture.currentFence,
    });

    expect(candidate).toMatchObject({
      version: 1,
      retained: false,
      runId: fixture.operation.runId,
      process: {
        processId: fixture.operation.previousProcessId,
        operationId: fixture.operation.previousOperationId,
      },
      request: fixture.source.request,
      control: fixture.terminal.control,
      publisher: fixture.terminal.publisher,
      runStorePublisher: fixture.source.publisher,
      parentCheckpoint: fixture.source.parentCheckpoint,
      placement: fixture.terminal.placement,
      identity: fixture.terminal.identity,
      fence: fixture.currentFence,
      legacySource: {
        version: 1,
        terminalKey: fixture.terminalKey,
        completionKey: fixture.completionKey,
      },
      evidence: {
        terminal: fixture.terminal,
        completion: { input: expect.any(Object), phase: "committed", result: fixture.completion },
      },
    });
    expect(candidate.placement.shardIncarnationNonce).toBe("old-shard-incarnation-nonce");
    expect(candidate.fence.nonce).toBe("current-adoption-incarnation-nonce");
  });

  it("rejects source substitutions and a changed controller", async () => {
    const fixture = await createLegacyAdoptionFixture();
    fixtures.add(fixture.runStore);
    const changedRequest = {
      ...fixture.operation,
      runStore: {
        ...fixture.operation.runStore,
        request: {
          ...fixture.operation.runStore.request,
          input: { ...fixture.operation.runStore.request.input, id: "substituted-input" },
        },
      },
    };
    const changedControl = {
      ...fixture.operation,
      transition: {
        ...fixture.operation.transition,
        control: { ...fixture.operation.transition.control, epoch: 2 },
      },
    };
    const read = (operation: typeof fixture.operation) =>
      readLegacyProcessSource({
        storage: fixture.storage,
        environment: fixture.environment,
        operation,
        fence: fixture.currentFence,
      });

    await expect(read(changedRequest)).rejects.toThrow(/same completed source/);
    await expect(read(changedControl)).rejects.toThrow(/terminal receipt/);
  });

  it("rederives evidence read-only so the caller can atomically reject prior attempts", async () => {
    const fixture = await createLegacyAdoptionFixture();
    fixtures.add(fixture.runStore);
    const transitionOperationId = "different-legacy-transition";
    fixture.values.set(
      `harness-process-resume/v1/${encodeURIComponent(fixture.operation.runId)}/${encodeURIComponent(transitionOperationId)}`,
      {
        version: 1,
        operation: {
          runId: fixture.operation.runId,
          previousProcessId: fixture.operation.previousProcessId,
          previousOperationId: fixture.operation.previousOperationId,
          previousStepId: fixture.operation.previousStepId,
          transition: { operationId: transitionOperationId },
        },
        phase: "retained",
      },
    );

    const keysBefore = [...fixture.values.keys()];
    const first = await readLegacyProcessSource({
      storage: fixture.storage,
      environment: fixture.environment,
      operation: fixture.operation,
      fence: fixture.currentFence,
    });
    const again = await readLegacyProcessSource({
      storage: fixture.storage,
      environment: fixture.environment,
      operation: fixture.operation,
      fence: fixture.currentFence,
    });

    expect(again).toEqual(first);
    expect([...fixture.values.keys()]).toEqual(keysBefore);
    await expect(
      assertNoLegacyProcessResumeForSource({
        storage: fixture.storage,
        runId: fixture.operation.runId,
        processId: fixture.operation.previousProcessId,
        processOperationId: fixture.operation.previousOperationId,
        requestId: fixture.operation.previousStepId,
      }),
    ).rejects.toThrow(/already has a resume attempt/);
  });

  it("rejects an active A state even when the old terminal and completion receipts match", async () => {
    const fixture = await createLegacyAdoptionFixture();
    fixtures.add(fixture.runStore);
    fixture.setAState({
      ...fixture.completion.supervisor,
      snapshot: { ...fixture.completion.supervisor.snapshot, lifecycle: "draining" },
    });

    await expect(
      readLegacyProcessSource({
        storage: fixture.storage,
        environment: fixture.environment,
        operation: fixture.operation,
        fence: fixture.currentFence,
      }),
    ).rejects.toThrow(/current state no longer matches/);
  });
});
