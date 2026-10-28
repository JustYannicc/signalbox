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

const resumeCases = [
  {
    scenario: "before-turn-two",
    evictions: ["after-replace"],
    restoreCount: 1,
    afterTurn: "keep-alive",
    stoppedAfterTurnTwo: { status: "stopped" },
  },
  {
    scenario: "before-turn-two-dispose",
    evictions: ["after-replace"],
    restoreCount: 1,
    afterTurn: "dispose",
    stoppedAfterTurnTwo: null,
  },
  {
    scenario: "after-turn-two-stop",
    evictions: ["after-turn-2"],
    restoreCount: 0,
    afterTurn: "keep-alive",
    stoppedAfterTurnTwo: { status: "stopped" },
  },
  {
    scenario: "after-turn-two-dispose",
    evictions: ["after-turn-2"],
    restoreCount: 0,
    afterTurn: "dispose",
    stoppedAfterTurnTwo: null,
  },
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

it.each(resumeCases)(
  "resumes the public C process from resume-one after $scenario",
  async ({ scenario, evictions, restoreCount, afterTurn, stoppedAfterTurnTwo }) => {
    const response = await harness.fetch(`http://proof/eviction-resume/${scenario}`);
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const { baseline, candidate } = JSON.parse(body);

    expect(candidate.scenario).toBe(scenario);
    expect(candidate.final).toEqual(baseline.final);
    expect(candidate.final.nativeSessionId).toBe("plain-native-session");
    expect(candidate.final.conversation).toHaveLength(3);
    expect(candidate.final.conversation.map((entry: string) => entry.split(":")[1])).toEqual([
      "turn-one",
      "turn-two",
      "turn-three",
    ]);
    expect(candidate.final.workspace).toBe(candidate.final.conversation.join("\n"));
    expect(candidate.thread).toEqual({
      threadId: "plain-thread",
      count: 3,
      requests: [
        { requestId: "turn-one", status: "completed" },
        { requestId: "turn-two", status: "completed" },
        { requestId: "turn-three", status: "completed" },
      ],
    });
    expect(candidate.evictions.map((entry: { readonly point: string }) => entry.point)).toEqual(
      evictions,
    );
    expect(baseline.evictions).toEqual([]);
    expect(candidate.evictionRestores).toHaveLength(restoreCount);
    expect(baseline.evictionRestores).toEqual([]);
    for (const restore of candidate.evictionRestores) {
      expect(restore.threadId).toBe("plain-thread");
      expect(restore.restoreCount).toBeGreaterThan(0);
      expect(Number.isFinite(restore.durationMs)).toBe(true);
      expect(restore.durationMs).toBeGreaterThanOrEqual(0);
      expect(restore.toNonce).not.toBe(restore.fromNonce);
    }

    expect(candidate.resumes).toHaveLength(2);
    expect(candidate.resumeOne).toMatchObject({
      operationId: "resume-one",
      duplicateDenied: true,
    });
    expect(candidate.resumeTwo.previousOperationId).toBe("resume-one");
    expect(candidate.resumeTwo.previousStepId).toBe("turn-two");
    expect(candidate.resumeTwo.runStoreProcessOperationId).toBe("resume-one");
    expect(candidate.resumeTwo.requestId).toBe("turn-two");
    expect(candidate.resumeTwo.requestParentCheckpoint).toEqual(candidate.turnTwo.parentCheckpoint);
    expect(candidate.resumeTwo.callerPublisher).toEqual(candidate.resumeOne.callerPublisher);
    expect(candidate.resumeTwo.transitionPublisher).toEqual(candidate.resumeTwo.currentAPublisher);
    expect(candidate.resumeTwo.identity.incarnationNonce).not.toBe(
      candidate.resumeTwo.currentAPublisher.facetNonce,
    );
    expect(candidate.resumeTwo.identity.incarnationNonce).not.toBe(
      candidate.resumeOne.callerPublisher.facetNonce,
    );
    expect(candidate.resumeTwo.publishedPublisher.facetNonce).toBe(
      candidate.resumeTwo.identity.incarnationNonce,
    );
    expect(candidate.resumeTwo.publishedPublisher.generation).toBeGreaterThan(
      candidate.resumeTwo.currentAPublisher.generation,
    );
    expect(candidate.resumeTwo.deniedBeforeValid).toEqual({
      staleControl: true,
      stalePublisher: true,
      staleCheckpoint: true,
      wrongRequest: true,
    });
    expect(candidate.resumeTwo.duplicateDenied).toBe(true);

    expect(candidate.turnTwo.afterTurn).toBe(afterTurn);
    expect(candidate.turnTwo.stopped).toEqual(stoppedAfterTurnTwo);
    if (stoppedAfterTurnTwo !== null)
      expect(candidate.turnTwo.duplicateStop).toEqual(stoppedAfterTurnTwo);
    expect(candidate.turnThree.duplicateMatches).toBe(true);
    expect(candidate.turnThree.staleCheckpointDenied).toBe(true);
    expect(candidate.statusAvailableAfterTurnThree).toBe(true);
    expect(candidate.stopped).toEqual({ status: "stopped" });
    expect(candidate.duplicateStop).toEqual(candidate.stopped);
  },
);
