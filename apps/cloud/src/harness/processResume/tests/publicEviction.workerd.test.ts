// @effect-diagnostics nodeBuiltinImport:off - this test bundles a plain fixture and runs the actual public DO roots in isolated local workerd.
import * as NodeProcess from "node:process";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createPublicResumeHarness } from "./publicResumeHarness.fixture.ts";

let harness: Awaited<ReturnType<typeof createPublicResumeHarness>>;
beforeAll(async () => {
  harness = await createPublicResumeHarness();
  await harness.listen();
}, 60_000);
afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
    NodeProcess.stdout.write("[public-C-harness-close-returned] publicEviction\n");
  }
});

const cases = [
  { point: "before-turn-1", expected: ["before-turn-1"] },
  { point: "after-turn-1", expected: ["after-turn-1"] },
  { point: "after-replace", expected: ["after-replace"] },
  { point: "after-turn-2", expected: ["after-turn-2"] },
  { point: "after-turn-3", expected: ["after-turn-3"] },
  { point: "before-stop", expected: ["before-stop"] },
  { point: "double", expected: ["after-turn-1", "after-replace"] },
] as const;

it.each(cases)(
  "recovers the public C process after $point eviction",
  async ({ point, expected }) => {
    const response = await harness.fetch(`http://proof/eviction/${point}`);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const { baseline, candidate } = JSON.parse(body);

    expect(candidate.final.conversation).toEqual(baseline.final.conversation);
    expect(candidate.final.workspace).toBe(baseline.final.workspace);
    expect(candidate.final.nativeSessionId).toBe(baseline.final.nativeSessionId);
    expect(candidate.final.conversation).toHaveLength(3);
    expect(candidate.final.conversation.map((entry: string) => entry.split(":")[1])).toEqual([
      "turn-one",
      "turn-two",
      "turn-three",
    ]);
    expect(candidate.final.workspace).toBe(candidate.final.conversation.join("\n"));

    expect(baseline.thread).toEqual({
      threadId: "plain-thread",
      count: 3,
      requests: [
        { requestId: "turn-one", status: "completed" },
        { requestId: "turn-two", status: "completed" },
        { requestId: "turn-three", status: "completed" },
      ],
    });
    expect(candidate.thread).toEqual(baseline.thread);
    expect(candidate.evictions.map((entry: { readonly point: string }) => entry.point)).toEqual(
      expected,
    );
    for (const eviction of candidate.evictions)
      expect(eviction.afterNonce).not.toBe(eviction.beforeNonce);

    const expectedRestoreCount = expected.filter(
      (point) => point === "after-replace" || point === "after-turn-2",
    ).length;
    expect(candidate.evictionRestores).toHaveLength(expectedRestoreCount);
    expect(baseline.evictionRestores).toEqual([]);
    for (const restore of candidate.evictionRestores) {
      expect(restore.threadId).toBe("plain-thread");
      expect(restore.restoreCount).toBeGreaterThan(0);
      expect(Number.isFinite(restore.durationMs)).toBe(true);
      expect(restore.durationMs).toBeGreaterThanOrEqual(0);
      expect(restore.toNonce).not.toBe(restore.fromNonce);
    }
    expect(candidate.resumes).toHaveLength(1);
    expect(candidate.replacements).toHaveLength(1);
    expect(candidate.replacements[0].publishedFacetNonce).toBe(
      candidate.replacements[0].incarnationNonce,
    );
    expect(candidate.replacements[0].incarnationNonce).not.toBe(candidate.initialIdentityNonce);
    expect(candidate.replacements[0].callerPublisher).toMatchObject({
      facetNonce: candidate.replacements[0].incarnationNonce,
    });
    expect(candidate.replacements[0].publishedGeneration).toBeGreaterThan(
      candidate.replacements[0].priorGeneration,
    );
    if ((expected as readonly string[]).includes("after-replace"))
      expect(candidate.physicalPublicationAfterTurnTwo.facetNonce).not.toBe(
        candidate.replacements[0].incarnationNonce,
      );
    else {
      expect(candidate.physicalPublicationAfterTurnTwo.facetNonce).toBe(
        candidate.replacements[0].incarnationNonce,
      );
      expect(candidate.physicalPublicationAfterTurnTwo.generation).toBe(
        candidate.replacements[0].publishedGeneration,
      );
    }
    if ((expected as readonly string[]).includes("after-replace"))
      expect(candidate.physicalPublicationAfterTurnTwo.generation).toBeGreaterThan(
        candidate.replacements[0].publishedGeneration,
      );
    if ((expected as readonly string[]).includes("after-turn-2")) {
      expect(candidate.physicalPublicationAfterTurnThree.facetNonce).not.toBe(
        candidate.physicalPublicationAfterTurnTwo.facetNonce,
      );
      expect(candidate.physicalPublicationAfterTurnThree.generation).toBeGreaterThan(
        candidate.physicalPublicationAfterTurnTwo.generation,
      );
    }
    if (
      (expected as readonly string[]).includes("after-turn-3") ||
      (expected as readonly string[]).includes("before-stop")
    )
      expect(candidate.preparedCountAfterStop).toBe(candidate.preparedCountBeforeStop);

    expect(candidate.duplicateResumeDenied).toBe(true);
    expect(candidate.duplicateContinuationsMatch).toBe(true);
    expect(candidate.callerPublisherStable).toBe(true);
    expect(candidate.staleCheckpointDenied).toBe(true);
    expect(candidate.staleResumeDenied).toBe(true);
    expect(candidate.staleContinueDenied).toBe(true);
    expect(candidate.staleStopDenied).toBe(true);
    expect(candidate.statusAvailableAfterTurnThree).toBe(true);
    expect(candidate.stopped).toEqual({ status: "stopped" });
    expect(candidate.duplicateStop).toEqual(candidate.stopped);
  },
);
