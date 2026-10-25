import { createSqliteRunStore } from "./plainRunStore.fixture.ts";
// @effect-diagnostics nodeBuiltinImport:off - the public RunStore service uses an isolated in-memory SQLite adapter here.
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "@effect/vitest";
import {
  snapshotHarnessProcessResumeRunStoreBinding,
  validateHarnessProcessResumeRunStoreDrain,
  validateHarnessProcessResumeRunStoreStart,
  type HarnessProcessResumeOperationInput,
  type HarnessProcessResumePreparedRelease,
  type HarnessProcessResumeRunStoreBinding,
  type HarnessProcessResumeRunStoreError,
} from "../../HarnessProcessResume.ts";
import {
  type HarnessRequestCheckpoint,
  type HarnessRequestPublisher,
  type HarnessRunStoreCommand,
} from "../../HarnessRunStore.ts";

const runId = "process-resume-run";
const controlKey = "process-resume-control-key-00000000000000000000000000000000";
const supervisorKey = "process-resume-supervisor-key-00000000000000000000000000000000";
const replacementKey = "process-resume-takeover-key-00000000000000000000000000000000";
const requestId = "resume-step";
const processId = "resume-process";
const processOperationId = "resume-process-operation";
const transitionOperationId = "resume-transition-operation";
const nextPublisherKey = "resume-next-publisher-capability-00000000000000000000000000000000";
const request = { requestId, input: reference("resume-step-input") };
const supervisor = { epoch: 2, claimId: "parent-two", supervisorKey: replacementKey };
const aControl = {
  ownerId: "process-resume-owner",
  incarnationId: "process-resume-incarnation",
  epoch: 8,
  controlKey: "process-resume-a-control-capability-00000000000000000000000000000000",
};
const nextAControl = {
  ...aControl,
  incarnationId: "process-resume-next-incarnation",
  epoch: 9,
  controlKey: "process-resume-next-a-control-capability-00000000000000000000000000000000",
};
const aPublisher = {
  generation: 2,
  facetNonce: "facet-2",
  publisherKey: "process-resume-a-publisher-capability-00000000000000000000000000000000",
};
const preparedRelease: HarnessProcessResumePreparedRelease = {
  artifact: {
    provider: "codex",
    releaseId: "resume-release",
    artifactHash: "a".repeat(64),
    artifactRef: "sha256:" + "a".repeat(64),
    sourceIdentity: "resume-source",
    fixtureIdentity: "resume-fixture",
    createdAt: "2026-10-24T08:00:00.000Z",
  },
  plan: {
    release: { harness: "codex", version: "1.0.0", manifestSha256: "a".repeat(64), modules: {} },
    sourceIdentity: "resume-source",
    computer: { sourceIdentity: "resume-computer", manifestSha256: "b".repeat(64) },
    preparedModules: {},
  },
};

function reference(id: string) {
  return { id, sha256: "a".repeat(64), bytes: 4 };
}
const checkpoint = (id: string): HarnessRequestCheckpoint => ({
  native: reference(id + "-native"),
  filesystem: reference(id + "-filesystem"),
});
const requestPublisher = (generation: number): HarnessRequestPublisher => ({
  generation,
  facetNonce: "facet-" + generation,
  publisherKey: "resume-journal-publisher-" + generation + "-00000000000000000000",
});

const initialCommand: HarnessRunStoreCommand = {
  type: "initialize",
  seed: {
    identity: {
      runId,
      hostId: "resume-host",
      threadId: "resume-thread",
      logicalTurnId: "resume-turn",
      filesystemId: "resume-files",
    },
    locator: reference("resume-locator"),
    config: reference("resume-config"),
    artifacts: [reference("resume-executable")],
  },
  controlKey,
  supervisorKey,
  claimId: "parent-one",
  requestId: "initialize-one",
};
const modeCommand: HarnessRunStoreCommand = {
  type: "request.mode",
  runId,
  controlKey,
  requestId: "request-mode",
  checkpoint: checkpoint("seed"),
};
const replaceFacet = (generation: number): HarnessRunStoreCommand => ({
  type: "request.replaceFacet",
  runId,
  controlKey,
  expectedGeneration: generation - 1,
  operationId: generation === 2 ? processOperationId : "replace-" + generation,
  facetNonce: "facet-" + generation,
  publisherKey: requestPublisher(generation).publisherKey,
});
const takeover: HarnessRunStoreCommand = {
  type: "takeover",
  runId,
  controlKey,
  supervisorKey: replacementKey,
  expectedEpoch: 1,
  claimId: "parent-two",
  requestId: "takeover-two",
};
const offer: HarnessRunStoreCommand = {
  type: "request.offer",
  runId,
  supervisor,
  request,
};
const admit: HarnessRunStoreCommand = {
  type: "request.admit",
  runId,
  requestId,
  publisher: requestPublisher(2),
};
const finish: HarnessRunStoreCommand = {
  type: "request.finish",
  runId,
  requestId,
  publisher: requestPublisher(2),
  finish: {
    sequence: 1,
    status: "completed",
    result: reference("resume-result"),
    checkpoint: checkpoint(requestId),
  },
};

async function setupRunStore() {
  const store = createSqliteRunStore(runId);
  await store.execute(initialCommand);
  await store.execute(modeCommand);
  await store.execute(replaceFacet(1));
  await store.execute(takeover);
  await store.execute(replaceFacet(2));
  await store.execute(offer);
  await store.execute(admit);
  const binding: HarnessProcessResumeRunStoreBinding = {
    runId,
    processId,
    processOperationId,
    transitionOperationId,
    controlKey,
    supervisor,
    currentPublisher: requestPublisher(2),
    nextPublisherKey,
    request,
    checkpoint: checkpoint("seed"),
  };
  const operation: HarnessProcessResumeOperationInput = {
    runId,
    previousProcessId: processId,
    previousOperationId: processOperationId,
    previousStepId: requestId,
    runStore: binding,
    transition: {
      operationId: transitionOperationId,
      control: aControl,
      publisher: aPublisher,
      nextControl: nextAControl,
      expectedFacetGeneration: 2,
      targetPreparedRelease: preparedRelease,
    },
    facet: {
      processId,
      codeId: "resume-code",
      residentBytes: 100,
      mainModule: "main.js",
      modules: { "main.js": "export default {}" },
      entrypoint: "Process",
    },
  };
  return {
    store,
    operation,
    binding,
    activeCheckpoint: {
      checkpointId: binding.checkpoint.native.id,
      manifestSha256: binding.checkpoint.filesystem.sha256,
    },
  };
}

describe("process resume RunStore binding", () => {
  it.effect(
    "uses the caller's initialized and taken-over capabilities through real no-op commands",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => setupRunStore());
        const before = yield* Effect.promise(() => fixture.store.execute({ type: "read", runId }));

        const result = yield* Effect.tryPromise(() =>
          validateHarnessProcessResumeRunStoreStart({
            store: fixture.store,
            operation: fixture.operation,
            activeCheckpoint: fixture.activeCheckpoint,
          }),
        );

        expect(result.action).toBe("observe-only");
        expect(result.snapshot).toEqual(before.snapshot);
        expect(JSON.stringify(result)).not.toContain(controlKey);
        expect(JSON.stringify(result)).not.toContain(replacementKey);
        expect(JSON.stringify(result)).not.toContain(requestPublisher(2).publisherKey);
        expect(JSON.stringify(result)).not.toContain(nextPublisherKey);
      }),
  );

  it.effect("rejects a missing binding before it reads or mutates RunStore", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setupRunStore());
      let calls = 0;
      const store = {
        execute(command: HarnessRunStoreCommand) {
          calls++;
          return fixture.store.execute(command);
        },
      };
      const operation = {
        ...fixture.operation,
        runStore: undefined as unknown as HarnessProcessResumeRunStoreBinding,
      };

      const result = yield* Effect.result(
        Effect.tryPromise(() =>
          validateHarnessProcessResumeRunStoreStart({
            store,
            operation,
            activeCheckpoint: fixture.activeCheckpoint,
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toBe(0);
    }),
  );

  it.effect(
    "rejects stale authority, publisher, request and checkpoint without changing the journal",
    () =>
      Effect.gen(function* () {
        const cases: Array<{
          readonly name: string;
          readonly reason: HarnessProcessResumeRunStoreError["reason"];
          readonly change: (
            value: HarnessProcessResumeRunStoreBinding,
          ) => HarnessProcessResumeRunStoreBinding;
        }> = [
          {
            name: "control capability",
            reason: "authority-changed",
            change: (value) => ({
              ...value,
              controlKey: "wrong-control-capability-00000000000000000000000000000000",
            }),
          },
          {
            name: "supervisor claim",
            reason: "authority-changed",
            change: (value) => ({
              ...value,
              supervisor: {
                ...value.supervisor,
                supervisorKey: "wrong-supervisor-capability-00000000000000000000000000000000",
              },
            }),
          },
          {
            name: "current publisher capability",
            reason: "publisher-changed",
            change: (value) => ({
              ...value,
              currentPublisher: {
                ...value.currentPublisher,
                publisherKey: "wrong-publisher-capability-00000000000000000000000000000000",
              },
            }),
          },
          {
            name: "request input artifact",
            reason: "request-changed",
            change: (value) => ({
              ...value,
              request: { ...value.request, input: reference("different-input") },
            }),
          },
          {
            name: "checkpoint envelope",
            reason: "checkpoint-changed",
            change: (value) => ({ ...value, checkpoint: checkpoint("different-checkpoint") }),
          },
        ];

        for (const scenario of cases) {
          const fixture = yield* Effect.promise(() => setupRunStore());
          const before = yield* Effect.promise(() =>
            fixture.store.execute({ type: "read", runId }),
          );

          const result = yield* Effect.result(
            Effect.tryPromise(() =>
              validateHarnessProcessResumeRunStoreStart({
                store: fixture.store,
                operation: { ...fixture.operation, runStore: scenario.change(fixture.binding) },
                activeCheckpoint: fixture.activeCheckpoint,
              }),
            ),
          );
          expect(Result.isFailure(result), scenario.name).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure.cause, scenario.name).toMatchObject({ reason: scenario.reason });

          const after = yield* Effect.promise(() => fixture.store.execute({ type: "read", runId }));
          expect(after.snapshot, scenario.name).toEqual(before.snapshot);
        }
      }),
  );

  it.effect("checks the completed request checkpoint after the admitted invocation drains", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setupRunStore());
      const started = yield* Effect.tryPromise(() =>
        validateHarnessProcessResumeRunStoreStart({
          store: fixture.store,
          operation: fixture.operation,
          activeCheckpoint: fixture.activeCheckpoint,
        }),
      );
      expect(started.snapshot.requests?.entries.at(-1)?.status).toBe("admitted");

      yield* Effect.promise(() => fixture.store.execute(finish));
      const completedCheckpoint = checkpoint(requestId);
      const result = yield* Effect.tryPromise(() =>
        validateHarnessProcessResumeRunStoreDrain({
          store: fixture.store,
          operation: fixture.operation,
          checkpoint: {
            checkpointId: completedCheckpoint.native.id,
            manifestSha256: completedCheckpoint.filesystem.sha256,
            nativeSessionId: "resume-native-session",
          },
        }),
      );

      expect(result.action).toBe("committed");
      expect(result.snapshot.requests?.checkpoint).toEqual(completedCheckpoint);
      expect(result.snapshot.requests?.entries.at(-1)?.finish?.checkpoint).toEqual(
        completedCheckpoint,
      );
    }),
  );

  it.effect("fails closed when the supervisor claim changes before drain completion", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setupRunStore());
      yield* Effect.promise(() => fixture.store.execute(finish));
      yield* Effect.promise(() =>
        fixture.store.execute({
          type: "takeover",
          runId,
          controlKey,
          supervisorKey: "process-resume-supervisor-three-00000000000000000000000000000000",
          expectedEpoch: 2,
          claimId: "parent-three",
          requestId: "takeover-three",
        }),
      );

      const result = yield* Effect.result(
        Effect.tryPromise(() =>
          validateHarnessProcessResumeRunStoreDrain({
            store: fixture.store,
            operation: fixture.operation,
            checkpoint: {
              checkpointId: checkpoint(requestId).native.id,
              manifestSha256: checkpoint(requestId).filesystem.sha256,
              nativeSessionId: "resume-native-session",
            },
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("does not expose capabilities when a RunStore transport result is unknown", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setupRunStore());
      const store = {
        execute: async (_command: HarnessRunStoreCommand) => {
          throw new Error(controlKey);
        },
      };
      const result = yield* Effect.result(
        Effect.tryPromise(() =>
          validateHarnessProcessResumeRunStoreStart({
            store,
            operation: fixture.operation,
            activeCheckpoint: fixture.activeCheckpoint,
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(controlKey);
    }),
  );

  it.effect("rejects extra fields instead of accepting a second source of authority", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => setupRunStore());
      expect(
        snapshotHarnessProcessResumeRunStoreBinding({
          ...fixture.binding,
          supervisorKey: "hidden-alternate-supervisor-key-00000000000000000000000000000000",
        }),
      ).toBeUndefined();
    }),
  );
});
