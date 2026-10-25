import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "@effect/vitest";
import {
  createHarnessProcessResume,
  HarnessProcessResumeDriverError,
  type HarnessProcessResumeDriver,
  type HarnessProcessResumePreparedRelease,
} from "../../HarnessProcessResume.ts";
import type { HarnessDurableStatePublicationResult } from "../../HarnessDurableState.ts";
import type { HarnessFilesPublication, HarnessFilesStoreResult } from "../../HarnessFilesStore.ts";
import type {
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorResult,
} from "../../HarnessThreadSupervisor.ts";

type Drain = { readonly operationId: string };
type Checkpoint = {
  readonly checkpointId: string;
  readonly manifestSha256: string;
  readonly nativeSessionId: string;
  readonly bytes: Uint8Array;
};
type PreparedFacet = {
  readonly facetNonce: string;
  readonly loaderId: string;
  readonly incarnationNonce: string;
  readonly identity: {
    readonly shardOwner: string;
    readonly loaderId: string;
    readonly facetKey: string;
    readonly incarnationNonce: string;
    readonly preparedRelease: HarnessProcessResumePreparedRelease;
  };
};
type Publication = HarnessDurableStatePublicationResult & {
  readonly control: HarnessThreadSupervisorControlClaim;
};
type CleanupEvidence = {
  readonly stopAcknowledged: boolean;
  readonly invocationRpcJoined: boolean;
  readonly fetchJoined: boolean;
  readonly callbackPortsJoined: boolean;
  readonly disposed: boolean;
};

type Driver = HarnessProcessResumeDriver<
  Drain,
  Checkpoint,
  PreparedFacet,
  Publication,
  CleanupEvidence
>;
type RecordedFailure = Parameters<Driver["recordFailure"]>[0];

const control = {
  ownerId: "owner-1",
  incarnationId: "incarnation-1",
  epoch: 8,
  controlKey: "a".repeat(32),
};
const nextControl = { ...control, epoch: 9, controlKey: "b".repeat(32) };
const publisher = {
  generation: 8,
  facetNonce: "facet-nonce-8",
  publisherKey: "c".repeat(32),
};
const drain: Drain = { operationId: "resume-9" };
const checkpoint: Checkpoint = {
  checkpointId: "checkpoint-8",
  manifestSha256: "manifest-sha256-8",
  nativeSessionId: "native-session-1",
  bytes: new Uint8Array([1, 2, 3]),
};
const preparedRelease: HarnessProcessResumePreparedRelease = {
  artifact: {
    provider: "claude-code",
    releaseId: "release-9",
    artifactHash: "a".repeat(64),
    artifactRef: `sha256:${"a".repeat(64)}`,
    sourceIdentity: "source-9",
    fixtureIdentity: "fixture-9",
    createdAt: "2026-10-24T08:00:00.000Z",
  },
  plan: {
    release: {
      harness: "claude-code",
      version: "2.3.4",
      manifestSha256: "a".repeat(64),
      modules: {
        "cli/main": { bytes: 17, sha256: "b".repeat(64) },
        "sdk/entry": { bytes: 23, sha256: "c".repeat(64) },
      },
    },
    sourceIdentity: "source-9",
    computer: { sourceIdentity: "computer-source-1", manifestSha256: "d".repeat(64) },
    preparedModules: {
      "cli/main": {
        component: "cli",
        name: "main",
        path: "cli/main.js",
        bytes: 17,
        sha256: "b".repeat(64),
        type: "js",
      },
      "sdk/entry": {
        component: "sdk",
        name: "entry",
        path: "sdk/entry.js",
        bytes: 23,
        sha256: "c".repeat(64),
        type: "js",
      },
    },
  },
};
const prepared: PreparedFacet = {
  facetNonce: "facet-nonce-9",
  loaderId: "loader-9",
  incarnationNonce: "incarnation-9",
  identity: {
    shardOwner: "supervisor/process-resume-test",
    loaderId: "loader-9",
    facetKey: "loader-9",
    incarnationNonce: "facet-nonce-9",
    preparedRelease,
  },
};
const publicationReceipt: HarnessFilesPublication = {
  operationId: drain.operationId,
  fromGeneration: 8,
  toGeneration: 9,
  priorFacetNonce: "facet-nonce-8",
  preparedFacetNonce: prepared.facetNonce,
  checkpoint: {
    checkpointId: checkpoint.checkpointId,
    manifestSha256: checkpoint.manifestSha256,
  },
  status: "confirmed",
};
const filesResult: HarnessFilesStoreResult = {
  action: "confirmed",
  checkpoint: {
    checkpointId: checkpoint.checkpointId,
    manifestSha256: checkpoint.manifestSha256,
  },
  parentCheckpointId: null,
  activeStepId: null,
  admissionResolution: null,
  publication: publicationReceipt,
  files: [{ path: "state.json", mode: 420, bytes: checkpoint.bytes }],
};
const supervisorResult: HarnessThreadSupervisorResult = {
  action: "published",
  snapshot: {
    runId: "run-1",
    ownerId: control.ownerId,
    controlIncarnationId: control.incarnationId,
    controlEpoch: nextControl.epoch,
    nativeSessionId: checkpoint.nativeSessionId,
    checkpoint: {
      checkpointId: checkpoint.checkpointId,
      manifestSha256: checkpoint.manifestSha256,
    },
    generation: 9,
    facetNonce: prepared.facetNonce,
    lifecycle: "published",
    admittedStepId: null,
    pendingControlSync: null,
    preparedFacet: {
      operationId: drain.operationId,
      generation: 9,
      facetNonce: prepared.facetNonce,
      checkpoint: {
        checkpointId: checkpoint.checkpointId,
        manifestSha256: checkpoint.manifestSha256,
      },
    },
    lastPublication: {
      operationId: drain.operationId,
      fromGeneration: 8,
      toGeneration: 9,
      priorFacetNonce: publisher.facetNonce,
      preparedFacetNonce: prepared.facetNonce,
      checkpoint: {
        checkpointId: checkpoint.checkpointId,
        manifestSha256: checkpoint.manifestSha256,
      },
    },
    lastPublicationOperationId: drain.operationId,
    stopAcknowledgementId: "stop-1",
    settlement: {
      outcome: "stopped",
      invocationRpcJoined: true,
      fetchJoined: true,
      callbackPortsJoined: true,
    },
    lastFailure: null,
    reconciliationEvidenceId: null,
    reconciliationExpectedGeneration: null,
    reconciliationAdmissionResolution: null,
    reconciliationOutcome: null,
    reconciliationCheckpoint: null,
    reconciliationInvocationSettlement: null,
    reconciliationPreparedFacetCleanup: null,
  },
  currentPublisher: {
    generation: 9,
    facetNonce: prepared.facetNonce,
    publisherKey: "d".repeat(32),
  },
  preparedPublisher: {
    generation: 9,
    facetNonce: prepared.facetNonce,
    publisherKey: "d".repeat(32),
  },
};
const publication: Publication = {
  status: "published",
  control: nextControl,
  supervisor: supervisorResult,
  files: filesResult,
  receipt: publicationReceipt,
};
const pendingPublication: Publication = {
  status: "supervisor-pending",
  control: nextControl,
  files: {
    ...filesResult,
    action: "pending",
    publication: { ...publicationReceipt, status: "pending" },
  },
  receipt: { ...publicationReceipt, status: "pending" },
  failure: { code: "STORAGE", message: "Supervisor publication is still pending." },
};
const cleanupEvidence: CleanupEvidence = {
  stopAcknowledged: true,
  invocationRpcJoined: false,
  fetchJoined: false,
  callbackPortsJoined: false,
  disposed: false,
};
const input = {
  operationId: drain.operationId,
  control,
  publisher,
  nextControl,
  expectedFacetGeneration: 8,
  targetPreparedRelease: preparedRelease,
};

const driverFailure = (operation: HarnessProcessResumeDriverError["operation"]) =>
  Effect.fail(
    new HarnessProcessResumeDriverError({
      operation,
      cause: new Error(`fixture ${operation} failure`),
    }),
  );

const makeDriver = (
  overrides: (context: {
    readonly events: string[];
    readonly failures: RecordedFailure[];
  }) => Partial<Driver> = () => ({}),
  testInput = input,
) => {
  const events: string[] = [];
  const failures: RecordedFailure[] = [];
  const defaults: Driver = {
    beginDrain(value) {
      events.push("beginDrain");
      expect(value).toEqual(testInput);
      return Effect.succeed(drain);
    },
    awaitDrain() {
      events.push("awaitDrain");
      return Effect.succeed({ _tag: "committed", checkpoint });
    },
    isCurrentControl(value) {
      events.push("isCurrentControl");
      expect(value).toEqual({ drain, control: nextControl });
      return Effect.succeed(true);
    },
    readNativeSessionId(value) {
      events.push("readNativeSessionId");
      expect(value).toEqual({ drain, control: nextControl });
      return Effect.succeed(checkpoint.nativeSessionId);
    },
    verifyCheckpoint(value) {
      events.push("verifyCheckpoint");
      expect(value).toEqual({ checkpoint, nativeSessionId: checkpoint.nativeSessionId });
      return Effect.void;
    },
    prepareInert(value) {
      events.push("prepareInert");
      expect(value).toEqual({
        drain,
        control: nextControl,
        publisher,
        operationId: testInput.operationId,
        checkpoint,
        nativeSessionId: checkpoint.nativeSessionId,
        targetPreparedRelease: testInput.targetPreparedRelease,
        expectedFacetGeneration: testInput.expectedFacetGeneration,
      });
      expect(value.targetPreparedRelease).not.toBe(testInput.targetPreparedRelease);
      expect(Object.isFrozen(value.targetPreparedRelease.plan.release.modules)).toBe(true);
      return Effect.succeed(prepared);
    },
    verifyPrepared(value) {
      events.push("verifyPrepared");
      expect(value).toEqual({
        drain,
        prepared,
        checkpoint,
        nativeSessionId: checkpoint.nativeSessionId,
        targetPreparedRelease: testInput.targetPreparedRelease,
      });
      return Effect.void;
    },
    persistPrepared(value) {
      events.push("persistPrepared");
      expect(value).toEqual({
        drain,
        control: nextControl,
        publisher,
        operationId: testInput.operationId,
        prepared,
        checkpoint,
        nativeSessionId: checkpoint.nativeSessionId,
        targetPreparedRelease: testInput.targetPreparedRelease,
        expectedFacetGeneration: testInput.expectedFacetGeneration,
      });
      return Effect.void;
    },
    publishFreshFacet(value) {
      events.push("publishFreshFacet");
      expect(value).toEqual({
        drain,
        control: nextControl,
        operationId: testInput.operationId,
        prepared,
        checkpoint,
        nativeSessionId: checkpoint.nativeSessionId,
        targetPreparedRelease: testInput.targetPreparedRelease,
        expectedFacetGeneration: testInput.expectedFacetGeneration,
      });
      return Effect.succeed(publication);
    },
    activate(value) {
      events.push("activate");
      expect(value).toEqual({
        drain,
        control: nextControl,
        operationId: testInput.operationId,
        prepared,
        publication,
      });
      expect(value.publication).toBe(publication);
      return Effect.void;
    },
    cleanupPrepared(value) {
      events.push("cleanupPrepared");
      expect(value).toEqual(prepared);
      return Effect.succeed({ _tag: "complete", evidence: cleanupEvidence });
    },
    recordFailure(value) {
      events.push("recordFailure");
      failures.push(value);
      return Effect.succeed("recorded" as const);
    },
  };
  return { driver: { ...defaults, ...overrides({ events, failures }) }, events, failures };
};

const run = (driver: Driver, testInput = input) =>
  createHarnessProcessResume(driver).resume(testInput).pipe(Effect.result);

describe("harness process resume failure handling", () => {
  it.effect("does not open a fresh process after an indeterminate drain", () =>
    Effect.gen(function* () {
      const { driver, events, failures } = makeDriver(({ events }) => ({
        awaitDrain() {
          events.push("awaitDrain");
          return Effect.succeed({ _tag: "indeterminate" });
        },
      }));
      const result = yield* run(driver);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          stage: "settlement",
          reason: "indeterminate",
          recovery: "recorded",
        });
      expect(events).toEqual(["beginDrain", "awaitDrain", "isCurrentControl", "recordFailure"]);
      expect(failures).toMatchObject([
        { stage: "settlement", reason: "indeterminate", cleanup: null },
      ]);
    }),
  );

  it.effect("fails closed on a fresh facet bound to a different prepared artifact", () =>
    Effect.gen(function* () {
      const wrongPrepared: PreparedFacet = {
        ...prepared,
        identity: {
          ...prepared.identity,
          preparedRelease: {
            ...preparedRelease,
            artifact: { ...preparedRelease.artifact, releaseId: "another-release" },
          },
        },
      };
      const { driver, events, failures } = makeDriver(({ events }) => ({
        prepareInert(value) {
          events.push("prepareInert");
          expect(value.targetPreparedRelease).toEqual(preparedRelease);
          return Effect.succeed(wrongPrepared);
        },
        cleanupPrepared() {
          events.push("cleanupPrepared");
          return Effect.succeed({
            _tag: "complete",
            evidence: {
              stopAcknowledged: true,
              invocationRpcJoined: true,
              fetchJoined: true,
              callbackPortsJoined: true,
              disposed: true,
            },
          });
        },
      }));
      const result = yield* run(driver);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          stage: "fresh-verification",
          reason: "prepared-release-mismatch",
          recovery: "recorded",
        });
      expect(events).not.toContain("verifyPrepared");
      expect(events).not.toContain("persistPrepared");
      expect(events).not.toContain("publishFreshFacet");
      expect(events).not.toContain("activate");
      expect(events).toContain("cleanupPrepared");
      expect(failures).toMatchObject([
        {
          targetPreparedRelease: preparedRelease,
          prepared: wrongPrepared,
          stage: "fresh-verification",
          reason: "prepared-release-mismatch",
        },
      ]);
    }),
  );

  it.effect("fails closed when the fresh facet omits its loaded artifact observation", () =>
    Effect.gen(function* () {
      const missingObservation = structuredClone(prepared);
      Reflect.deleteProperty(missingObservation.identity, "preparedRelease");
      const { driver, events } = makeDriver(({ events }) => ({
        prepareInert() {
          events.push("prepareInert");
          return Effect.succeed(missingObservation);
        },
        cleanupPrepared(value) {
          events.push("cleanupPrepared");
          expect(value).toEqual(missingObservation);
          return Effect.succeed({ _tag: "complete", evidence: cleanupEvidence });
        },
      }));
      const result = yield* run(driver);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          stage: "fresh-verification",
          reason: "prepared-release-mismatch",
          recovery: "recorded",
        });
      expect(events).not.toContain("persistPrepared");
      expect(events).not.toContain("publishFreshFacet");
      expect(events).not.toContain("activate");
    }),
  );

  it.effect("compares complete prepared identity independent of nested record key order", () =>
    Effect.gen(function* () {
      const reorderedTarget: HarnessProcessResumePreparedRelease = {
        artifact: { ...preparedRelease.artifact },
        plan: {
          ...preparedRelease.plan,
          release: {
            ...preparedRelease.plan.release,
            modules: {
              "sdk/entry": preparedRelease.plan.release.modules["sdk/entry"]!,
              "cli/main": preparedRelease.plan.release.modules["cli/main"]!,
            },
          },
          preparedModules: {
            "sdk/entry": preparedRelease.plan.preparedModules["sdk/entry"]!,
            "cli/main": preparedRelease.plan.preparedModules["cli/main"]!,
          },
        },
      };
      const testInput = { ...input, targetPreparedRelease: reorderedTarget };
      const { driver } = makeDriver(() => ({}), testInput);
      const result = yield* run(driver, testInput);

      expect(Result.isSuccess(result)).toBe(true);
    }),
  );

  it.effect("snapshots the target descriptor before awaiting the drain", () =>
    Effect.gen(function* () {
      const expectedInput = {
        ...input,
        targetPreparedRelease: structuredClone(preparedRelease),
      };
      const suppliedTarget = structuredClone(preparedRelease);
      const suppliedInput = { ...input, targetPreparedRelease: suppliedTarget };
      const { driver } = makeDriver(() => ({}), expectedInput);
      const result = createHarnessProcessResume(driver).resume(suppliedInput).pipe(Effect.result);

      Object.assign(suppliedTarget.artifact, { releaseId: "mutated-after-call" });
      Object.assign(suppliedTarget.plan.release.modules["cli/main"]!, {
        sha256: "f".repeat(64),
      });
      const completed = yield* result;

      expect(Result.isSuccess(completed)).toBe(true);
    }),
  );

  it.effect("records incomplete prepared cleanup evidence when inert verification fails", () =>
    Effect.gen(function* () {
      const { driver, events, failures } = makeDriver(({ events }) => ({
        verifyPrepared() {
          events.push("verifyPrepared");
          return driverFailure("fresh-verification");
        },
        cleanupPrepared() {
          events.push("cleanupPrepared");
          return Effect.succeed({ _tag: "incomplete", evidence: cleanupEvidence });
        },
      }));
      const result = yield* run(driver);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          stage: "cleanup",
          reason: "cleanup-failed",
          failedStage: "fresh-verification",
          recovery: "recorded",
        });
      expect(events).toEqual([
        "beginDrain",
        "awaitDrain",
        "isCurrentControl",
        "readNativeSessionId",
        "verifyCheckpoint",
        "prepareInert",
        "verifyPrepared",
        "cleanupPrepared",
        "isCurrentControl",
        "recordFailure",
      ]);
      expect(failures).toMatchObject([
        {
          stage: "cleanup",
          reason: "cleanup-failed",
          priorReason: "driver-failed",
          prepared,
          cleanup: { _tag: "incomplete", evidence: cleanupEvidence },
        },
      ]);
    }),
  );

  it.effect("records prepared identity cleanup evidence when persistence fails", () =>
    Effect.gen(function* () {
      const { driver, events, failures } = makeDriver(({ events }) => ({
        persistPrepared() {
          events.push("persistPrepared");
          return driverFailure("fresh-verification");
        },
        cleanupPrepared() {
          events.push("cleanupPrepared");
          return Effect.succeed({ _tag: "incomplete", evidence: cleanupEvidence });
        },
      }));
      const result = yield* run(driver);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          stage: "cleanup",
          reason: "cleanup-failed",
          failedStage: "fresh-verification",
          recovery: "recorded",
        });
      expect(events).toEqual([
        "beginDrain",
        "awaitDrain",
        "isCurrentControl",
        "readNativeSessionId",
        "verifyCheckpoint",
        "prepareInert",
        "verifyPrepared",
        "persistPrepared",
        "cleanupPrepared",
        "isCurrentControl",
        "recordFailure",
      ]);
      expect(events).not.toContain("publishFreshFacet");
      expect(failures).toMatchObject([
        {
          control: nextControl,
          operationId: input.operationId,
          stage: "cleanup",
          reason: "cleanup-failed",
          prepared,
          cleanup: { _tag: "incomplete", evidence: cleanupEvidence },
        },
      ]);
    }),
  );

  it.effect("keeps the inert placement and receipt when composed publication is pending", () =>
    Effect.gen(function* () {
      const { driver, events, failures } = makeDriver(({ events }) => ({
        publishFreshFacet() {
          events.push("publishFreshFacet");
          return Effect.succeed(pendingPublication);
        },
      }));
      const result = yield* run(driver);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          stage: "publication",
          reason: "publication-pending",
          recovery: "recorded",
        });
      expect(events).toEqual([
        "beginDrain",
        "awaitDrain",
        "isCurrentControl",
        "readNativeSessionId",
        "verifyCheckpoint",
        "prepareInert",
        "verifyPrepared",
        "persistPrepared",
        "publishFreshFacet",
        "isCurrentControl",
        "recordFailure",
      ]);
      expect(events).not.toContain("cleanupPrepared");
      expect(events).not.toContain("activate");
      expect(failures).toMatchObject([
        {
          stage: "publication",
          reason: "publication-pending",
          prepared,
          publication: pendingPublication,
          cleanup: null,
        },
      ]);
    }),
  );

  it.effect("keeps the inert placement when the publication reply is lost", () =>
    Effect.gen(function* () {
      const { driver, events, failures } = makeDriver(({ events }) => ({
        publishFreshFacet() {
          events.push("publishFreshFacet");
          return driverFailure("publication");
        },
      }));
      const result = yield* run(driver);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          stage: "publication",
          reason: "driver-failed",
          recovery: "recorded",
        });
      expect(events.filter((event) => event === "publishFreshFacet")).toHaveLength(1);
      expect(events).not.toContain("cleanupPrepared");
      expect(events).not.toContain("activate");
      expect(failures).toMatchObject([{ stage: "publication", prepared, cleanup: null }]);
    }),
  );

  it.effect("retains the published identity for explicit repair after activation fails", () =>
    Effect.gen(function* () {
      const { driver, events, failures } = makeDriver(({ events }) => ({
        activate() {
          events.push("activate");
          return driverFailure("activation");
        },
      }));
      const result = yield* run(driver);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          stage: "activation",
          reason: "activation-failed",
          recovery: "recorded",
        });
      expect(events.indexOf("verifyPrepared")).toBeLessThan(events.indexOf("persistPrepared"));
      expect(events.indexOf("persistPrepared")).toBeLessThan(events.indexOf("publishFreshFacet"));
      expect(events.indexOf("publishFreshFacet")).toBeLessThan(events.indexOf("activate"));
      expect(events).not.toContain("cleanupPrepared");
      expect(failures).toMatchObject([
        { stage: "activation", reason: "activation-failed", prepared, publication, cleanup: null },
      ]);
    }),
  );

  it.effect("does not activate or write under a controller claim rejected at publication", () =>
    Effect.gen(function* () {
      let currentChecks = 0;
      const { driver, events, failures } = makeDriver(({ events }) => ({
        isCurrentControl() {
          events.push("isCurrentControl");
          currentChecks += 1;
          return Effect.succeed(currentChecks === 1);
        },
        publishFreshFacet() {
          events.push("publishFreshFacet");
          return driverFailure("publication");
        },
      }));
      const result = yield* run(driver);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          stage: "publication",
          reason: "driver-failed",
          recovery: "claim-changed",
        });
      expect(events).toContain("persistPrepared");
      expect(events).not.toContain("activate");
      expect(events).not.toContain("cleanupPrepared");
      expect(events).not.toContain("recordFailure");
      expect(failures).toHaveLength(0);
    }),
  );

  it.effect("rejects a published A result with a different full control claim", () =>
    Effect.gen(function* () {
      const stalePublication: Publication = { ...publication, control };
      const { driver, events, failures } = makeDriver(({ events }) => ({
        publishFreshFacet() {
          events.push("publishFreshFacet");
          return Effect.succeed(stalePublication);
        },
      }));
      const result = yield* run(driver);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          stage: "publication",
          reason: "stale-control",
          recovery: "recorded",
        });
      expect(events).not.toContain("activate");
      expect(failures).toMatchObject([
        {
          stage: "publication",
          reason: "stale-control",
          publication: stalePublication,
        },
      ]);
    }),
  );

  it.effect(
    "rejects a confirmed A result whose supervisor snapshot names another native session",
    () =>
      Effect.gen(function* () {
        const stalePublication: Publication = {
          ...publication,
          supervisor: {
            ...supervisorResult,
            snapshot: { ...supervisorResult.snapshot, nativeSessionId: "another-session" },
          },
        };
        const { driver, events, failures } = makeDriver(({ events }) => ({
          publishFreshFacet() {
            events.push("publishFreshFacet");
            return Effect.succeed(stalePublication);
          },
        }));
        const result = yield* run(driver);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure).toMatchObject({
            stage: "publication",
            reason: "identity-or-checkpoint-mismatch",
            recovery: "recorded",
          });
        expect(events.filter((event) => event === "publishFreshFacet")).toHaveLength(1);
        expect(events).not.toContain("activate");
        expect(events).not.toContain("cleanupPrepared");
        expect(failures).toMatchObject([
          {
            stage: "publication",
            reason: "identity-or-checkpoint-mismatch",
            publication: stalePublication,
            cleanup: null,
          },
        ]);
      }),
  );
});
