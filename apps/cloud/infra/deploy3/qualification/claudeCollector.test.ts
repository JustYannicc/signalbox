import { expect, it } from "vite-plus/test";
import type { HarnessProcessResumePreparedRelease } from "../../../src/harness/HarnessProcessResume.ts";
import { CLAUDE_WORKLOAD_ACTIONS, collectClaudeQualificationWorkload } from "./claudeCollector.ts";
import type {
  CollectClaudeQualificationWorkloadInput,
  ClaudeQualificationActionPin,
  ClaudeQualificationEventPin,
} from "./claudeCollector.ts";
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
const ref = (id: string) => ({ id, bytes: 7, sha256: hash });
const turn = {
  requestId: "request-one",
  status: "completed",
  input: ref("input"),
  result: ref("result"),
  checkpoint: { native: ref("native"), filesystem: ref("filesystem") },
} as const;
const publicRunPin: ClaudeQualificationEventPin = {
  identity: "claude-facet",
  entrypoint: "ClaudeFacet",
  tag: "public-run",
  route: { method: "POST", path: "/facet/run" },
  invocationId: "request-one",
};
const actionPins: ClaudeQualificationActionPin[] = CLAUDE_WORKLOAD_ACTIONS.map((action) => ({
  action,
  identity: `action-${action}`,
  entrypoint: "default",
  tag: action,
  route: { method: "POST", path: `/${action}` },
  invocationId: `invocation-${action}`,
}));
function event(pin: ClaudeQualificationEventPin, milestone: "entered" | "terminal") {
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
      isolateNonce: "module-init-one",
    },
  };
}
const observerRecords = [
  event(publicRunPin, "entered"),
  ...actionPins.flatMap((pin) => [event(pin, "entered"), event(pin, "terminal")]),
  event(publicRunPin, "terminal"),
];
function input(
  overrides: Partial<CollectClaudeQualificationWorkloadInput> = {},
): CollectClaudeQualificationWorkloadInput {
  return {
    classification: "synthetic",
    scenario: "baseline",
    runId: "run-one",
    requestId: "request-one",
    coldStartupUpperBound: timing,
    turn,
    expectedPreparedRelease: expected,
    loadedPreparedRelease: expected,
    moduleInitNonceBefore: "module-init-one",
    moduleInitNonceAfter: "module-init-one",
    publicRunPin,
    actionPins,
    observerTrace: {
      producerEvents: observerRecords.map(
        (record) => (record as { producerEvent: unknown }).producerEvent,
      ),
      observerFailures: [],
    },
    ...overrides,
  };
}

it("collects only exact producer pairs and keeps deployed policy and qualification pending", () => {
  const evidence = collectClaudeQualificationWorkload(input());
  expect(evidence.qualification).toBe("pending");
  expect(evidence.classification).toBe("synthetic");
  expect(evidence.deployedPolicyEvidence).toEqual({
    status: "pending",
    label: "platform policy compliance evidence",
  });
  expect(evidence.criteria.every((criterion) => criterion.status === "pending")).toBe(true);
  expect(evidence.criteria.every((criterion) => criterion.detail.length > 0)).toBe(true);
});

it("rejects missing events, incomplete requests, and a changed loaded plan identity", () => {
  expect(() =>
    collectClaudeQualificationWorkload(
      input({ observerTrace: { producerEvents: [], observerFailures: [] } }),
    ),
  ).toThrow("CLAUDE_QUALIFICATION_WORKLOAD_EVENT_INCOMPLETE");
  expect(() =>
    collectClaudeQualificationWorkload(
      input({
        turn: { ...turn, status: "failed" } as unknown as typeof turn,
      }),
    ),
  ).toThrow("CLAUDE_QUALIFICATION_WORKLOAD_COMPLETION_MISSING");
  const changed: HarnessProcessResumePreparedRelease = {
    ...expected,
    plan: {
      ...expected.plan,
      computer: { ...expected.plan.computer, manifestSha256: "e".repeat(64) },
    },
  };
  expect(() =>
    collectClaudeQualificationWorkload(input({ loadedPreparedRelease: changed })),
  ).toThrow("CLAUDE_QUALIFICATION_LOADED_RELEASE_MISMATCH");
});
