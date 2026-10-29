import { expect, it } from "vite-plus/test";
import type { HarnessProcessResumePreparedRelease } from "../../../src/harness/HarnessProcessResume.ts";
import type { HarnessRequestFacetCreationObservation } from "../../../src/harness/HarnessRequestFacet.ts";
import { observeClaudeColdStartup } from "./scenario.ts";
import type { ColdFirstSuccessfulRpcTiming, PublicClaudeQualificationFacet } from "./contracts.ts";

const hash = "a".repeat(64);
const preparedRelease = (): HarnessProcessResumePreparedRelease => ({
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
      version: "2.1.312",
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
});

const creation = (): HarnessRequestFacetCreationObservation => ({
  facetNonce: "synthetic-facet-nonce",
  nativeSessionId: "synthetic-native-session",
  checkpoint: {
    native: { id: "native-checkpoint", bytes: 1, sha256: hash },
    filesystem: { id: "files-checkpoint", bytes: 1, sha256: hash },
  },
  manifestRevision: hash,
  joined: { invocationRpc: true, fetch: true, ports: true },
  filesCheckpoint: {
    checkpointId: "native-checkpoint",
    parentCheckpointId: null,
    files: [],
  },
});

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

function facet(input: {
  readonly order: string[];
  readonly observed?: HarnessProcessResumePreparedRelease;
}): PublicClaudeQualificationFacet {
  const actual = input.observed ?? preparedRelease();
  return {
    async identity() {
      input.order.push("identity");
      return { facetNonce: "synthetic-facet-nonce" };
    },
    async startFresh() {
      input.order.push("startFresh");
      return creation();
    },
    async loadedPreparedRelease() {
      input.order.push("loadedPreparedRelease");
      return actual;
    },
    async dispose() {
      input.order.push("dispose");
    },
  };
}

it("keeps synthetic public cold-start observations separate from qualification claims", async () => {
  const order: string[] = [];
  const observed = await observeClaudeColdStartup({
    scenario: "baseline",
    operationId: "synthetic-operation",
    publisherKey: "synthetic-publisher-key-0123456789",
    expected: preparedRelease(),
    calibrationPins: [{ path: "calibration.json", bytes: 1, sha256: hash }],
    timer: {
      async measureColdFirstSuccessfulRpc(invokeCold) {
        order.push("start-parent-timer-before-cold-rpc");
        const value = await invokeCold();
        order.push("successful-startFresh-response");
        return { value, timing };
      },
    },
    acquireFacet: async () => {
      order.push("acquire-public-facet");
      return facet({ order });
    },
  });

  expect(order).toEqual([
    "start-parent-timer-before-cold-rpc",
    "acquire-public-facet",
    "identity",
    "startFresh",
    "successful-startFresh-response",
    "loadedPreparedRelease",
    "dispose",
  ]);
  expect(observed.coldStartupUpperBound).toEqual(timing);
  expect(observed.loadedPreparedRelease).toEqual(preparedRelease());
  expect(observed.resourceEvidence).toMatchObject({
    status: "pending",
    strictByteBound: false,
    calibrationPins: [{ path: "calibration.json", sha256: hash }],
    workloadCompletion: { status: "not-run" },
    sessionClose: { status: "closed", acknowledged: true },
  });
  expect(observed.criteria.every((criterion) => criterion.status === "pending")).toBe(true);
  expect(observed.metrics.bootTimeMs.state).toBe("unmeasured");
  expect(observed.metrics.peakHeapBytes.state).toBe("unmeasured");
});

it("disposes the public facet and rejects loaded identity drift", async () => {
  const order: string[] = [];
  const original = preparedRelease();
  const changed: HarnessProcessResumePreparedRelease = {
    ...original,
    plan: {
      ...original.plan,
      computer: { ...original.plan.computer, manifestSha256: "e".repeat(64) },
    },
  };
  await expect(
    observeClaudeColdStartup({
      scenario: "hooks",
      operationId: "synthetic-operation",
      publisherKey: "synthetic-publisher-key-0123456789",
      expected: preparedRelease(),
      calibrationPins: [],
      timer: {
        async measureColdFirstSuccessfulRpc(invokeCold) {
          return { value: await invokeCold(), timing };
        },
      },
      acquireFacet: async () => facet({ order, observed: changed }),
    }),
  ).rejects.toThrow("CLAUDE_QUALIFICATION_LOADED_RELEASE_MISMATCH");
  expect(order.at(-1)).toBe("dispose");
});
