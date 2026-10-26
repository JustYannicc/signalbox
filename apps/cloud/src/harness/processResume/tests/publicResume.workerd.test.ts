// @effect-diagnostics nodeBuiltinImport:off - this test bundles a plain fixture and runs the actual public DO roots in isolated local workerd.
import * as NodeURL from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

let harness: ReturnType<typeof createTestHarness>;
beforeAll(async () => {
  const compile = async (variant: string) => {
    const result = await build({
      entryPoints: [
        NodeURL.fileURLToPath(new URL("./plainFacet.workerd.fixture.ts", import.meta.url)),
      ],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "esnext",
      external: ["cloudflare:workers", "node:*"],
      define: { PLAIN_VARIANT: JSON.stringify(variant) },
      write: false,
    });
    const source = result.outputFiles[0]?.text;
    if (source === undefined) throw new Error("The plain fixture bundle is empty.");
    return source;
  };
  const old = await compile("old");
  const next = await compile("next");
  const third = await compile("third");
  harness = createTestHarness({
    workers: [
      {
        config: {
          name: "1396-public-resume-proof",
          main: NodeURL.fileURLToPath(
            new URL("./publicResume.workerd.fixture.ts", import.meta.url),
          ),
          compatibility_date: "2026-10-19",
          compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
          worker_loaders: [{ binding: "LOADER" }],
          vars: {
            RESIDENT_BYTE_LIMIT: "128000000",
            OLD_SOURCE: old,
            NEW_SOURCE: next,
            THIRD_SOURCE: third,
          },
          durable_objects: {
            bindings: [
              { name: "PROCESS_EXECUTION_SHARDS", class_name: "ProofShard" },
              { name: "PLACEMENT_STORES", class_name: "ProofPlacementStore" },
              { name: "HARNESS_FILES_STORE", class_name: "ProofFilesStore" },
              { name: "HARNESS_RUN_STORE", class_name: "ProofRunStore" },
              { name: "HARNESS_THREAD_SUPERVISOR", class_name: "ProofSupervisor" },
            ],
          },
          migrations: [
            {
              tag: "v1",
              new_sqlite_classes: [
                "ProofShard",
                "ProofPlacementStore",
                "ProofFilesStore",
                "ProofRunStore",
                "ProofSupervisor",
              ],
            },
          ],
        },
      },
    ],
  });
  await harness.listen();
}, 60_000);
afterAll(async () => {
  if (harness !== undefined) await harness.close();
});

it("consumes real durable stop evidence after A rehydration in the same shard and rejects a missing observed release", async () => {
  const response = await harness.fetch("http://proof/missing-observation");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.initial[0].status).toBe("settled");
  expect(result.completed).toBe("committed");
  expect(result.manifestMatches).toBe(true);
  expect(result.aRehydrated).toBe(true);
  expect(result.aSnapshotRetained).toBe(true);
  expect(result.sameShard).toBe(true);
  expect(result.status.failure).toEqual({
    stage: "fresh-verification",
    reason: "prepared-release-mismatch",
  });
  expect(
    Object.values(result.observations).some(
      (row) =>
        typeof row === "object" && row !== null && "variant" in row && row.variant === "next",
    ),
  ).toBe(true);
  expect(result.observations["proof/event/observed-release-returned"]).toBeUndefined();
  expect(result.resumed.ok).toBe(false);
  expect(result.status.status).toBe("retained");
  expect(result.status.terminalEvidencePersisted).toBe(true);
  expect(result.status.preparedIdentityPersisted).toBe(false);
  expect(result.journalFacetCount).toBe(2);
  expect(result.journalRequestCount).toBe(1);
  expect(result.releases[0].terminal).toHaveLength(1);
  expect(result.releases[0].terminal[0]).toMatchObject({
    stopped: true,
    joined: { invocationRpc: true, fetch: true, ports: true },
  });
});

it("rejects an actually loaded mismatched release before prepared persistence or publication", async () => {
  const result = await scenario("/mismatched-observation");
  expect(result.resumed.ok).toBe(false);
  expect(result.status.failure).toEqual({
    stage: "fresh-verification",
    reason: "prepared-release-mismatch",
  });
  expect(result.status.preparedIdentityPersisted).toBe(false);
  expect(result.evidence.resumes).toEqual([{ phase: "retained", prepared: false }]);
  expect(result.observations["proof/event/observed-release-returned"].artifact.releaseId).toMatch(
    /^plain-third-/,
  );
  expect(result.postResume.currentPublisher.generation).toBe(result.previousPublisherGeneration);
  expect(result.postResume.snapshot.lifecycle).toBe("stopped");
  expect(result.postResume.snapshot.lastPublication).toEqual(result.previousPublication);
  expect(result.postResume.snapshot.lastPublicationOperationId).toBe(
    result.previousPublicationOperationId,
  );
  expect(result.postResume.snapshot.preparedFacet).toEqual(result.previousPreparedFacet);
  expect(result.journalFacetCount).toBe(2);
  expect(result.releases[0].terminal).toHaveLength(1);
});

it("resumes actual verified plain fixture code, then accepts a later request and the next completed boundary", async () => {
  const response = await harness.fetch("http://proof/positive");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.resumed.ok, body).toBe(true);
  expect(result.invalidBootstrapRejected).toBe(true);
  expect(result.invalidBootstrapDidNotDrain).toBe(true);
  expect(result.changedRestoreModeRejected).toBe(true);
  expect(result.nextStatus).toBe("settled");
  expect(result.nextCompleted).toBe("committed");
  expect(result.secondResume.status).toBe("resumed");
  expect(result.sameShard).toBe(true);
  expect(result.duplicateIdentityMatches).toBe(true);
  expect(result.mutatedRejected).toBe(true);
  expect(
    new Set([
      result.initial[0].identity.loaderId,
      result.resumed.value.identity.loaderId,
      result.secondResume.identity.loaderId,
    ]).size,
  ).toBe(3);
  expect(
    new Set([
      result.initial[0].identity.incarnationNonce,
      result.resumed.value.identity.incarnationNonce,
      result.secondResume.identity.incarnationNonce,
    ]).size,
  ).toBe(3);
  expect(result.journalFacetCount).toBe(4);
  expect(result.journalRequestCount).toBe(2);
  expect(result.finishes).toEqual([
    { requestId: "turn-one", status: "completed", generation: 2 },
    { requestId: "turn-two", status: "completed", generation: 3 },
  ]);
  const invoked = Object.keys(result.observations).filter((key) => key.includes("/invoked:"));
  expect(invoked).toHaveLength(2);
  expect(result.evidence.terminal).toHaveLength(2);
  expect(result.evidence.resumes.every((row: { phase: string }) => row.phase === "active")).toBe(
    true,
  );
  const transports = result.transports as readonly {
    readonly productBootstrap: {
      readonly provider: string;
      readonly preparedReleaseId: string;
      readonly restoreMode: string;
    };
    readonly targetPreparedRelease: {
      readonly artifact: { readonly provider: string; readonly releaseId: string };
      readonly plan: { readonly release: { readonly manifestSha256: string } };
    };
    readonly productCapability: string;
    readonly resumeRunId: string;
    readonly resumeControl: { readonly ownerId: string };
    readonly resumePublisher: { readonly publisherKey: string };
    readonly processIdentity: {
      readonly processId: string;
      readonly shardOwner: string;
      readonly loaderId: string;
      readonly facetKey: string;
    };
    readonly requestPublisher: { readonly generation: number; readonly publisherKey: string };
  }[];
  expect(transports).toHaveLength(3);
  expect(
    transports.filter(
      (row) => row.productBootstrap.restoreMode === "same-variant-serialized-checkpoint",
    ),
  ).toHaveLength(1);
  expect(
    transports.filter((row) => row.productBootstrap.restoreMode === "cross-variant-fresh-boot"),
  ).toHaveLength(2);
  const expectedProductTransports = result.expectedProductTransports as readonly {
    readonly productBootstrap: { readonly preparedReleaseId: string } | null;
    readonly targetPreparedRelease: unknown;
  }[];
  expect(
    transports
      .map(({ productBootstrap, targetPreparedRelease }) => ({
        productBootstrap,
        targetPreparedRelease,
      }))
      .toSorted((left, right) =>
        (left.productBootstrap?.preparedReleaseId ?? "").localeCompare(
          right.productBootstrap?.preparedReleaseId ?? "",
        ),
      ),
  ).toEqual(
    expectedProductTransports.toSorted((left, right) =>
      (left.productBootstrap?.preparedReleaseId ?? "").localeCompare(
        right.productBootstrap?.preparedReleaseId ?? "",
      ),
    ),
  );
  for (const row of transports) {
    expect(row.productBootstrap.provider).toBe("claude-code");
    expect(row.productBootstrap.preparedReleaseId).toBe(
      row.targetPreparedRelease.artifact.releaseId,
    );
    expect(row.targetPreparedRelease.artifact.provider).toBe("claude-code");
    expect(row.targetPreparedRelease.plan.release.manifestSha256).toBeTruthy();
    expect(row.productCapability).toBe("authorized-workerd-product-capability");
    expect(row.resumeRunId.startsWith("plain-positive-")).toBe(true);
    expect(row.resumeControl.ownerId).toBe("plain-process-owner");
    expect(row.resumePublisher.publisherKey).not.toBe("caller-a-publisher");
    expect(row.processIdentity.processId).toBe("plain-process");
    expect(row.processIdentity.shardOwner).not.toBe("caller-owner");
    expect(row.processIdentity.loaderId).not.toBe("caller-loader");
    expect(row.processIdentity.facetKey).not.toBe("caller-facet");
    expect(row.requestPublisher.generation).toBeGreaterThan(0);
    expect(row.requestPublisher.publisherKey).not.toBe("caller-publisher");
  }
});

it("forwards the authorized capability when the initial process has no typed bootstrap", async () => {
  const result = await scenario("/transport-without-typed-bindings");
  expect(result.resumed.ok).toBe(true);
  const transports = result.transports as readonly {
    readonly productBootstrap: {
      readonly provider: string;
      readonly preparedReleaseId: string;
      readonly restoreMode: string;
    } | null;
    readonly targetPreparedRelease: {
      readonly artifact: { readonly releaseId: string };
    } | null;
    readonly productCapability: string;
    readonly processIdentity: { readonly processId: string };
  }[];
  expect(transports).toHaveLength(3);
  const initial = transports.find((row) => row.productBootstrap === null);
  expect(initial?.targetPreparedRelease).toBeNull();
  expect(initial?.productCapability).toBe("authorized-workerd-product-capability");
  const replacements = transports.filter((row) => row.productBootstrap !== null);
  expect(replacements).toHaveLength(2);
  for (const row of replacements) {
    expect(row.productCapability).toBe("authorized-workerd-product-capability");
    expect(row.productBootstrap?.preparedReleaseId).toBe(
      row.targetPreparedRelease?.artifact.releaseId,
    );
  }
  expect(transports.every((row) => row.processIdentity.processId === "plain-process")).toBe(true);
});

async function scenario(path: string) {
  const response = await harness.fetch(`http://proof${path}`);
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return JSON.parse(body);
}

it("rejects wrong completion bindings and mutated duplicates without another durable commit", async () => {
  const result = await scenario("/completion/wrong-bindings");
  expect(result.denied).toEqual([true, true, true, true, true]);
  expect(result.before.completion).toEqual([]);
  expect(result.result.processes[0].status).toBe("settled");
  expect(result.duplicate).toBe("committed");
  expect(result.changedDuplicate).toBe(true);
  expect(result.releases).toHaveLength(1);
});

it.each([
  "changed-bytes",
  "wrong-native-envelope",
  "lost-files",
  "partial-supervisor",
  "lost-supervisor",
  "stale-authority",
])("retains exact completion ownership after %s", async (name) => {
  const result = await scenario(`/completion/${name}`);
  expect(result.denied, JSON.stringify(result)).toBe(true);
  expect(result.duplicateDenied).toBe(true);
  expect(result.result.processes[0].status).toBe("recoverable");
  expect(result.releases).toEqual([]);
  expect(result.evidence.terminal).toEqual([]);
  expect(result.ownership.writer).toBe(true);
  expect(result.ownership.leases).toBe(1);
  if (name === "changed-bytes" || name === "lost-supervisor")
    expect(result.checkpoint).toBe("turn-one-native");
  if (name === "partial-supervisor")
    expect(result.evidence.completionDetails[0].result).toBe("supervisor-pending");
});

it.each(["terminal-write", "terminal-reply", "unjoined"])(
  "keeps the real B lease when %s prevents terminal proof",
  async (name) => {
    const result = await scenario(`/completion/${name}`);
    expect(result.denied, JSON.stringify(result)).toBe(false);
    expect(result.result.processes[0].status).toBe("recoverable");
    expect(result.ownership.writer).toBe(true);
    expect(result.ownership.leases).toBe(1);
    expect(result.releases).toEqual([]);
    expect(result.evidence.terminal).toHaveLength(name === "terminal-reply" ? 1 : 0);
  },
);

it.each(["lost-publication", "activation-failure", "unknown-authority"])(
  "retains published ownership after %s without replay",
  async (name) => {
    const result = await scenario(`/resume/${name}`);
    expect(result.denied, JSON.stringify(result)).toBe(true);
    expect(result.duplicateDenied).toBe(true);
    expect(result.status.status).toBe("retained");
    expect(result.status.preparedIdentityPersisted).toBe(true);
    expect(result.ownership.writer).toBe(true);
    expect(result.ownership.leases).toBe(1);
    expect(result.releases).toHaveLength(1);
    expect(
      Object.keys(result.observations).filter((key) => key.includes("/invoked:")),
    ).toHaveLength(1);
  },
);

it("awaits an owned remote call on cancellation and prevents late publication", async () => {
  const result = await scenario("/cancellation");
  expect(result.settledBeforeRelease).toBe(false);
  expect(result.cancellationResult.status).toBe("retained");
  expect(result.denied).toBe(true);
  expect(result.duplicateDenied).toBe(true);
  expect(result.final.status).toBe("retained");
  expect(result.final.preparedIdentityPersisted).toBe(false);
  expect(result.releases).toHaveLength(1);
});

it("keeps fetch and callback ownership until their actual joins precede durable evidence and release", async () => {
  const result = await scenario("/held-work");
  for (const held of [result.beforeFetch, result.beforeCallback]) {
    expect(held.evidence.terminal).toEqual([]);
    expect(held.releases).toEqual([]);
    expect(held.ownership.writer).toBe(true);
    expect(held.ownership.leases).toBe(1);
  }
  expect(result.result.processes[0].status).toBe("settled");
  expect(result.releases[0].terminal[0].joined).toEqual({
    invocationRpc: true,
    fetch: true,
    ports: true,
  });
});

it("reauthenticates cached success and preserves full prepared evidence across C reconstruction", async () => {
  const result = await scenario("/cached-authority");
  expect(result.first.status).toBe("resumed");
  expect(result.duplicateDenied).toBe(true);
  expect(result.runDenied).toBe(true);
  expect(result.after).toEqual(result.before);
  expect(result.after.resumes[0].selected).toEqual(result.after.resumes[0].observed);
  expect(Object.keys(result.after.resumes[0].observed.plan.preparedModules)).not.toHaveLength(0);
  expect(result.status.preparedIdentityPersisted).toBe(true);
  expect(result.status.identity.incarnationNonce).toBe(result.first.identity.incarnationNonce);
  expect(result.ownership.writer).toBe(true);
  expect(result.ownership.leases).toBe(1);
});

it("joins a committed publication with a held reply on cancellation and retains its lease without activating", async () => {
  const result = await scenario("/publication-cancellation");
  expect(result.before.cancelled).toBe(false);
  expect(result.before.releases).toHaveLength(1);
  expect(result.denied).toBe(true);
  expect(result.duplicateDenied).toBe(true);
  expect(result.final.status).toBe("retained");
  expect(result.final.preparedIdentityPersisted).toBe(true);
  expect(result.lifecycle).toBe("activation-failed");
  expect(result.ownership.writer).toBe(true);
  expect(result.ownership.leases).toBe(1);
  expect(result.releases).toHaveLength(1);
  expect(Object.keys(result.observations).filter((key) => key.includes("/invoked:"))).toHaveLength(
    1,
  );
});

it.each(["reject", "failed-finish"])(
  "retains a failed initial invocation (%s) without waiting for an impossible completed checkpoint",
  async (name) => {
    const result = await scenario(`/invocation/${name}`);
    expect(result.result.processes[0].status).toBe("recoverable");
    expect(result.evidence.completion).toEqual([]);
    expect(result.evidence.terminal).toEqual([]);
    expect(result.ownership.writer).toBe(true);
    expect(result.ownership.leases).toBe(1);
    expect(result.releases).toEqual([]);
    expect(result.requestStatus).toBe(name === "reject" ? "admitted" : "completed");
    if (name === "failed-finish") expect(result.finishStatus).toBe("failed");
  },
);
