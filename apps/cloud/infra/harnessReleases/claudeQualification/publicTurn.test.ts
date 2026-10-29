import { expect, it } from "vite-plus/test";
import type { HarnessRunStoreResult } from "../../../src/harness/HarnessRunStore.ts";
import { runClaudeQualificationPublicTurn } from "./publicTurn.ts";
import type { PublicClaudeQualificationTurnFacet } from "./publicTurn.ts";
import type { ClaudeQualificationPreparedVariant } from "./candidateServices.ts";
import type { ColdFirstSuccessfulRpcTiming } from "./contracts.ts";

const hash = "a".repeat(64);
const reference = (id: string) => ({ id, bytes: 7, sha256: hash });
const expected = {
  artifact: {
    provider: "claude-code",
    releaseId: "synthetic-candidate",
    artifactHash: hash,
    artifactRef: "sha256:" + hash,
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
} as ClaudeQualificationPreparedVariant["expectedPreparedRelease"];
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
const committed = (requestId: string): HarnessRunStoreResult =>
  ({
    action: "committed",
    snapshot: {
      requests: {
        entries: [
          {
            request: { requestId, input: reference("turn-input") },
            status: "completed",
            finish: {
              status: "completed",
              result: reference("turn-result"),
              checkpoint: {
                native: reference("native-checkpoint"),
                filesystem: reference("filesystem-checkpoint"),
              },
            },
          },
        ],
      },
    },
  }) as unknown as HarnessRunStoreResult;

function makeFacet(input: {
  readonly order: string[];
  readonly result?: unknown;
  readonly observed?: ClaudeQualificationPreparedVariant["expectedPreparedRelease"];
}): PublicClaudeQualificationTurnFacet {
  return {
    identity() {
      input.order.push("identity");
      return { facetNonce: "synthetic-facet-nonce" };
    },
    async run() {
      input.order.push("run");
      return input.result ?? committed("request-one");
    },
    async loadedPreparedRelease() {
      input.order.push("loadedPreparedRelease");
      return input.observed ?? expected;
    },
    async dispose() {
      input.order.push("dispose");
    },
  };
}

it("times the first public run call and observes the exact committed request afterward", async () => {
  const order: string[] = [];
  const observed = await runClaudeQualificationPublicTurn({
    scenario: "baseline",
    requestId: "request-one",
    publisher: {
      generation: 1,
      facetNonce: "synthetic-facet-nonce",
      publisherKey: "synthetic-publisher-key-0123456789",
    },
    expected,
    timer: {
      async measureColdFirstSuccessfulRpc(invokeCold) {
        order.push("timer-start");
        const value = await invokeCold();
        order.push("timer-finish");
        return { value, timing };
      },
    },
    acquireFacet: async () => {
      order.push("acquire-fresh-facet");
      return makeFacet({ order });
    },
  });

  expect(order).toEqual([
    "timer-start",
    "acquire-fresh-facet",
    "run",
    "timer-finish",
    "identity",
    "loadedPreparedRelease",
    "dispose",
  ]);
  expect(observed).toMatchObject({
    status: "pending",
    firstPublicCall: "run",
    identityWarmupBeforeFirstCall: false,
    coldStartupUpperBound: timing,
    loadedPreparedRelease: expected,
    turn: {
      requestId: "request-one",
      status: "completed",
      input: reference("turn-input"),
      result: reference("turn-result"),
    },
  });
});

it("preserves cleanup when the public run does not commit the requested completed turn", async () => {
  const order: string[] = [];
  await expect(
    runClaudeQualificationPublicTurn({
      scenario: "hooks",
      requestId: "request-one",
      publisher: {
        generation: 1,
        facetNonce: "synthetic-facet-nonce",
        publisherKey: "synthetic-publisher-key-0123456789",
      },
      expected,
      timer: {
        async measureColdFirstSuccessfulRpc(invokeCold) {
          return { value: await invokeCold(), timing };
        },
      },
      acquireFacet: async () =>
        makeFacet({
          order,
          result: committed("another-request"),
        }),
    }),
  ).rejects.toThrow("CLAUDE_QUALIFICATION_PUBLIC_TURN_REQUEST_MISSING");
  expect(order).toEqual(["run", "identity", "dispose"]);
});

it("disposes the facet and rejects loaded release drift after the measured turn", async () => {
  const order: string[] = [];
  const changed = {
    ...expected,
    plan: {
      ...expected.plan,
      computer: { ...expected.plan.computer, manifestSha256: "e".repeat(64) },
    },
  } as ClaudeQualificationPreparedVariant["expectedPreparedRelease"];
  await expect(
    runClaudeQualificationPublicTurn({
      scenario: "baseline",
      requestId: "request-one",
      publisher: {
        generation: 1,
        facetNonce: "synthetic-facet-nonce",
        publisherKey: "synthetic-publisher-key-0123456789",
      },
      expected,
      timer: {
        async measureColdFirstSuccessfulRpc(invokeCold) {
          return { value: await invokeCold(), timing };
        },
      },
      acquireFacet: async () => makeFacet({ order, observed: changed }),
    }),
  ).rejects.toThrow("CLAUDE_QUALIFICATION_LOADED_RELEASE_MISMATCH");
  expect(order.at(-1)).toBe("dispose");
});
