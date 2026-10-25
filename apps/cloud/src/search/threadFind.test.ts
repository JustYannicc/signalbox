import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  PlanId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { verifyThreadFindMatchEvidence } from "@t3tools/shared/threadFindMatchEvidence";
import { searchableMessageDocument, searchablePlanDocument } from "@t3tools/shared/threadFindText";
import * as DateTime from "effect/DateTime";
import { findProjectedThreadItems } from "./threadFind.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { applyEvents } from "../thread/threadProjection.ts";
import { decide } from "../thread/threadDecider.ts";

const threadId = ThreadId.make("cloud-find-child");
const parentId = ThreadId.make("cloud-find-parent");
const now = DateTime.makeUnsafe("2026-10-18T10:00:00.000Z");
const base = (id: string) => ({
  id: TurnItemId.make(id),
  threadId: parentId,
  runId: RunId.make("parent-run"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});
const message = (text: string) => ({
  ...base("message-item"),
  type: "assistant_message" as const,
  messageId: MessageId.make("message"),
  text,
  streaming: false,
});
const projected = (
  item: OrchestrationV2TurnItem,
  position = 0,
): OrchestrationV2ProjectedTurnItem => ({
  position,
  visibility: "inherited",
  sourceThreadId: parentId,
  sourceItemId: item.id,
  item,
});

function projection(rows: readonly OrchestrationV2ProjectedTurnItem[]) {
  const decision = decide(
    null,
    {
      type: "thread.create",
      commandId: CommandId.make("create-find"),
      createdBy: "user",
      creationSource: "web",
      threadId,
      projectId: ProjectId.make("find-project"),
      title: "Find",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    },
    { now },
  );
  if (decision._tag !== "accepted") throw new Error(decision.message);
  const created = applyEvents(null, decision.events);
  if (created === null) throw new Error("missing projection");
  return { ...created, visibleTurnItems: rows };
}

describe("cloud Find evidence", () => {
  it("keeps inherited exact evidence valid across newer owning snapshots", () => {
    const source = message("😀 **ΟΣ**\n\nος");
    const state = projection([projected(source), projected(message("unrelated"), 1)]);
    const input = { threadId, query: "οσ", index: 1 };
    const first = findProjectedThreadItems(state, input, 10);
    const later = findProjectedThreadItems(
      { ...state, updatedAt: DateTime.add(now, { seconds: 1 }) },
      input,
      30,
    );
    expect(first.totalMatches).toBe(2);
    expect(first.match).toMatchObject({
      entryId: "message",
      occurrence: 1,
      evidence: { version: 1, segmentIndex: 1, start: 0, end: 2 },
    });
    expect(later.snapshotSequence).toBe(30);
    expect(later.match).toEqual(first.match);
    expect(
      verifyThreadFindMatchEvidence(
        searchableMessageDocument({ ...source, role: "assistant" })!,
        input.query,
        1,
        first.match?.evidence,
      ),
    ).toEqual({ segmentIndex: 1, start: 0, end: 2 });
  });

  it("rejects stale same-length original sources even when semantic text is unchanged", () => {
    const source = message("[needle](https://a.test) needle");
    const input = { threadId, query: "needle", index: 1 };
    const first = findProjectedThreadItems(projection([projected(source)]), input, 10);
    const changed = { ...source, text: source.text.replace("a.test", "b.test") };
    const later = findProjectedThreadItems(projection([projected(changed)]), input, 11);
    expect(later.totalMatches).toBe(first.totalMatches);
    expect(later.match?.evidence?.documentId).not.toBe(first.match?.evidence?.documentId);
    const document = searchableMessageDocument({ ...changed, role: "assistant" })!;
    expect(
      verifyThreadFindMatchEvidence(document, input.query, 1, first.match?.evidence),
    ).toBeNull();
    expect(
      verifyThreadFindMatchEvidence(document, input.query, 1, later.match?.evidence),
    ).not.toBeNull();
  });

  it("binds skill display labels and exact query intervals to the same source", () => {
    const source = message("Use $check now");
    const input = {
      threadId,
      query: "needle",
      skills: [{ name: "check", displayName: "needle One" }],
    };
    const first = findProjectedThreadItems(projection([projected(source)]), input, 10);
    const skills = [{ name: "check", displayName: "needle Two" }];
    const changed = findProjectedThreadItems(
      projection([projected(source)]),
      { ...input, skills },
      10,
    );
    const document = searchableMessageDocument(
      { ...source, role: "assistant" },
      undefined,
      skills,
    )!;
    expect(first.totalMatches).toBe(1);
    expect(changed.totalMatches).toBe(1);
    expect(
      verifyThreadFindMatchEvidence(document, input.query, 0, first.match?.evidence),
    ).toBeNull();
    expect(
      verifyThreadFindMatchEvidence(document, input.query, 0, changed.match?.evidence),
    ).not.toBeNull();
    expect(verifyThreadFindMatchEvidence(document, "need", 0, changed.match?.evidence)).toBeNull();
  });

  it("adds plan evidence and leaves nonrich tool matches without it", () => {
    const plan = {
      ...base("plan"),
      type: "proposed_plan" as const,
      planId: PlanId.make("plan"),
      markdown: "# Needle\n\nShip it",
      streaming: false,
    };
    const tool = {
      ...base("tool"),
      type: "command_execution" as const,
      input: "echo needle",
      output: "",
      exitCode: 0,
    };
    const state = projection([projected(plan), projected(tool, 1)]);
    const first = findProjectedThreadItems(state, { threadId, query: "needle" }, 20);
    expect(first.totalMatches).toBe(2);
    expect(first.navigation?.map((row) => row.entryId)).toEqual(["plan", "tool"]);
    expect(
      verifyThreadFindMatchEvidence(
        searchablePlanDocument(plan.markdown),
        "needle",
        0,
        first.match?.evidence,
      ),
    ).toEqual({ segmentIndex: 0, start: 0, end: 6 });
    const last = findProjectedThreadItems(state, { threadId, query: "needle", index: 1 }, 20);
    expect(last.match).toEqual({ entryId: "tool", runId: tool.runId, occurrence: 0 });
    expect(findProjectedThreadItems(state, { threadId, query: "absent" }, 20).match).toBeNull();
  });
});
