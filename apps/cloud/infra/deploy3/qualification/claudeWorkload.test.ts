import { expect, it } from "vite-plus/test";
import type { HarnessRunStoreResult } from "../../../src/harness/HarnessRunStore.ts";
import type { HarnessProcessResumePreparedRelease } from "../../../src/harness/HarnessProcessResume.ts";
import type { PublicClaudeQualificationTurnFacet } from "../../harnessReleases/claudeQualification/publicTurn.ts";
import { CLAUDE_WORKLOAD_ACTIONS } from "./claudeCollector.ts";
import type {
  ClaudeQualificationActionPin,
  ClaudeQualificationEventPin,
} from "./claudeCollector.ts";
import { measureColdFirstSuccessfulRpc, runClaudeQualificationWorkload } from "./claudeWorkload.ts";
import type { ColdFirstSuccessfulRpcTiming } from "../../harnessReleases/claudeQualification/contracts.ts";

const hash = "a".repeat(64);
const expected: HarnessProcessResumePreparedRelease = {
  artifact: {
    provider: "claude-code",
    releaseId: "synthetic-candidate",
    artifactHash: hash,
    artifactRef: `sha256:${hash}`,
    sourceIdentity: "b".repeat(64),
    fixtureIdentity: "synthetic-only",
    createdAt: "2026-10-29T00:00:00.000Z",
  },
  plan: {
    release: {
      harness: "claude-code",
      version: "2.1.999",
      manifestSha256: hash,
      modules: { "cli/main.js": { bytes: 12, sha256: hash } },
    },
    sourceIdentity: "b".repeat(64),
    computer: { sourceIdentity: "c".repeat(64), manifestSha256: "d".repeat(64) },
    preparedModules: {
      "cli/main.js": {
        component: "cli",
        name: "main.js",
        path: "cli/main.js",
        bytes: 12,
        sha256: hash,
        type: "js",
      },
    },
  },
};
const timing: ColdFirstSuccessfulRpcTiming = {
  label: "cold first-successful-RPC latency",
  interpretation: "startup upper bound",
  clock: "parent process.hrtime.bigint",
  startedMonotonicNs: "1000000",
  finishedMonotonicNs: "2000000",
  milliseconds: 1,
  includesRpc: true,
  exactBootTime: false,
};
const publicRunPin: ClaudeQualificationEventPin = {
  identity: "claude-facet",
  entrypoint: "ClaudeFacet",
  tag: "public-run",
  route: { method: "POST", path: "/facet/run" },
  invocationId: "request-one",
};
const actionPins: ClaudeQualificationActionPin[] = CLAUDE_WORKLOAD_ACTIONS.map((action) => ({
  action,
  identity: `claude-${action}`,
  entrypoint: "default",
  tag: action,
  route: { method: "POST", path: `/${action}` },
  invocationId: `invocation-${action}`,
}));
const ref = (id: string) => ({ id, bytes: 7, sha256: hash });

function committed(
  requestId: string,
  status: "completed" | "failed" = "completed",
): HarnessRunStoreResult {
  return {
    action: "committed",
    snapshot: {
      requests: {
        entries: [
          {
            request: { requestId, input: ref("turn-input") },
            status,
            finish: {
              status,
              result: ref("turn-result"),
              checkpoint: {
                native: ref("native-checkpoint"),
                filesystem: ref("filesystem-checkpoint"),
              },
            },
          },
        ],
      },
    },
  } as unknown as HarnessRunStoreResult;
}

function producerEvent(
  pin: ClaudeQualificationEventPin,
  milestone: "entered" | "terminal",
  nonce = "module-init-one",
) {
  return {
    producerEvent: {
      schema: "sb1070/producer/v1",
      runId: "run-one",
      identity: pin.identity,
      producerClass: "dynamic-worker",
      workerId: `worker-${pin.identity}`,
      entrypoint: pin.entrypoint,
      tag: pin.tag,
      route: pin.route,
      invocationId: pin.invocationId,
      milestone,
      isolateNonce: nonce,
    },
  };
}

const observerRecords = () => [
  producerEvent(publicRunPin, "entered"),
  ...actionPins.flatMap((pin) => [producerEvent(pin, "entered"), producerEvent(pin, "terminal")]),
  producerEvent(publicRunPin, "terminal"),
];
const observerTrace = () => ({
  producerEvents: observerRecords().map(
    (record) => (record as { producerEvent: unknown }).producerEvent,
  ),
  observerFailures: [],
});

function facet(input: {
  readonly order: string[];
  readonly nonceBefore?: string;
  readonly nonceAfter?: string;
  readonly runResult?: unknown;
}): PublicClaudeQualificationTurnFacet {
  return {
    identity() {
      input.order.push("identity");
      return { facetNonce: "facet-nonce" };
    },
    async run() {
      input.order.push("run");
      return {
        ...((input.runResult ?? committed("request-one")) as object),
        isolateNonce: input.nonceBefore ?? "module-init-one",
      };
    },
    async loadedPreparedRelease() {
      input.order.push("loaded-release");
      return { ...expected, isolateNonce: input.nonceAfter ?? "module-init-one" };
    },
    async dispose() {
      input.order.push("dispose");
    },
  };
}

it("times the first public run, checks one module-init nonce, and leaves qualification pending", async () => {
  const order: string[] = [];
  const observed = await runClaudeQualificationWorkload({
    classification: "synthetic",
    scenario: "baseline",
    runId: "run-one",
    requestId: "request-one",
    expectedPreparedRelease: expected,
    publisher: {
      generation: 1,
      facetNonce: "facet-nonce",
      publisherKey: "synthetic-publisher-key-0123456789",
    },
    publicRunPin,
    actionPins,
    timer: {
      async measureColdFirstSuccessfulRpc(invokeCold) {
        order.push("timer-start");
        const value = await invokeCold();
        order.push("timer-finish");
        return { value, timing };
      },
    },
    acquireFacet: async () => {
      order.push("acquire-facet");
      return facet({ order });
    },
    readObserverTrace: async (input) => {
      order.push("read-observer-records");
      expect(input.invocationIds).toEqual([
        "request-one",
        ...actionPins.map((pin) => pin.invocationId),
      ]);
      return observerTrace();
    },
  });

  expect(order).toEqual([
    "timer-start",
    "acquire-facet",
    "run",
    "timer-finish",
    "identity",
    "loaded-release",
    "dispose",
    "read-observer-records",
  ]);
  expect(observed).toMatchObject({
    classification: "synthetic",
    status: "observed",
    qualification: "pending",
    firstPublicCall: "run",
    identityWarmupBeforeFirstCall: false,
    coldStartupUpperBound: timing,
    loadedPreparedRelease: expected,
    workloadCompletion: { requestId: "request-one", status: "completed" },
    moduleInitNonce: { before: "module-init-one", after: "module-init-one", same: true },
    deployedPolicyEvidence: { status: "pending", label: "platform policy compliance evidence" },
  });
  expect(observed.criteria.map((criterion) => criterion.name)).toEqual([
    "boot",
    "text",
    "readEdit",
    "bash",
    "grep",
    "resume",
    "mcp",
    "publicHarness",
  ]);
  expect(observed.criteria.find((criterion) => criterion.name === "readEdit")?.events).toHaveLength(
    2,
  );
});

it("keeps the cold startup measurement labeled as an upper bound around the successful RPC", async () => {
  let invoked = false;
  const measured = await measureColdFirstSuccessfulRpc(async () => {
    invoked = true;
    return "ready";
  });
  expect(measured.value).toBe("ready");
  expect(invoked).toBe(true);
  expect(measured.timing).toMatchObject({
    label: "cold first-successful-RPC latency",
    interpretation: "startup upper bound",
    includesRpc: true,
    exactBootTime: false,
  });
  expect(
    BigInt(measured.timing.finishedMonotonicNs) >= BigInt(measured.timing.startedMonotonicNs),
  ).toBe(true);
});

it("disposes the facet and rejects a failed public turn without collecting success evidence", async () => {
  const order: string[] = [];
  let collected = false;
  await expect(
    runClaudeQualificationWorkload({
      classification: "synthetic",
      scenario: "hooks",
      runId: "run-one",
      requestId: "request-one",
      expectedPreparedRelease: expected,
      publisher: {
        generation: 1,
        facetNonce: "facet-nonce",
        publisherKey: "synthetic-publisher-key-0123456789",
      },
      publicRunPin,
      actionPins,
      acquireFacet: async () => facet({ order, runResult: committed("request-one", "failed") }),
      readObserverTrace: async () => {
        collected = true;
        return observerTrace();
      },
    }),
  ).rejects.toThrow("CLAUDE_QUALIFICATION_PUBLIC_TURN_NOT_COMPLETED");
  expect(order).toEqual(["run", "identity", "dispose"]);
  expect(collected).toBe(false);
});

it("rejects a public turn whose durable request has no completion", async () => {
  const order: string[] = [];
  const missingFinish = {
    action: "committed",
    snapshot: {
      requests: {
        entries: [
          {
            request: { requestId: "request-one", input: ref("turn-input") },
            status: "admitted",
            finish: null,
          },
        ],
      },
    },
  };
  await expect(
    runClaudeQualificationWorkload({
      classification: "synthetic",
      scenario: "baseline",
      runId: "run-one",
      requestId: "request-one",
      expectedPreparedRelease: expected,
      publisher: {
        generation: 1,
        facetNonce: "facet-nonce",
        publisherKey: "synthetic-publisher-key-0123456789",
      },
      publicRunPin,
      actionPins,
      acquireFacet: async () => facet({ order, runResult: missingFinish }),
      readObserverTrace: async () => observerTrace(),
    }),
  ).rejects.toThrow("CLAUDE_QUALIFICATION_PUBLIC_TURN_NOT_COMPLETED");
  expect(order).toContain("dispose");
  expect(order).not.toContain("loaded-release");
});

it("rejects changed module-init nonce and missing action events", async () => {
  const order: string[] = [];
  await expect(
    runClaudeQualificationWorkload({
      classification: "synthetic",
      scenario: "baseline",
      runId: "run-one",
      requestId: "request-one",
      expectedPreparedRelease: expected,
      publisher: {
        generation: 1,
        facetNonce: "facet-nonce",
        publisherKey: "synthetic-publisher-key-0123456789",
      },
      publicRunPin,
      actionPins,
      acquireFacet: async () => facet({ order, nonceAfter: "module-init-two" }),
      readObserverTrace: async () => observerTrace(),
    }),
  ).rejects.toThrow("CLAUDE_QUALIFICATION_MODULE_INIT_NONCE_CHANGED");

  const sameNonceOrder: string[] = [];
  await expect(
    runClaudeQualificationWorkload({
      classification: "synthetic",
      scenario: "baseline",
      runId: "run-one",
      requestId: "request-one",
      expectedPreparedRelease: expected,
      publisher: {
        generation: 1,
        facetNonce: "facet-nonce",
        publisherKey: "synthetic-publisher-key-0123456789",
      },
      publicRunPin,
      actionPins,
      acquireFacet: async () => facet({ order: sameNonceOrder }),
      readObserverTrace: async () => {
        const trace = observerTrace();
        return {
          ...trace,
          producerEvents: trace.producerEvents.filter(
            (value) => (value as { invocationId: string }).invocationId !== "invocation-mcp",
          ),
        };
      },
    }),
  ).rejects.toThrow("CLAUDE_QUALIFICATION_WORKLOAD_EVENT_INCOMPLETE");
});
