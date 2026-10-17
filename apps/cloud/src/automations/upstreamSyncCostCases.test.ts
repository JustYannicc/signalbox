import { assert, expect, it } from "@effect/vitest";

import { candidateWorkflow, makeHost } from "./tests/upstreamSyncCostHarness.ts";

const argumentOf = (calls: ReadonlyArray<ReadonlyArray<unknown>>, kind: string, index: number) => {
  const call = calls.find((candidate) => candidate[0] === kind);
  if (!call) throw new Error(`No ${kind} call was recorded.`);
  return call[index];
};

it("keeps the ten cost and direction cases unchanged in the compiled candidate", async () => {
  const run = await candidateWorkflow();
  const cost = {
    text: "RESULT: cost-blocked: real conflicts outweigh adapter fix\nIssue #999 has the evidence.",
    pullRequest: null,
    threadId: "new-thread",
  };
  const existing = {
    threadId: "existing-thread",
    url: "https://github.com/JustYannicc/signalbox/pull/999",
    number: 999,
  };
  let cases = 0;

  for (const hasExisting of [false, true]) {
    const h = makeHost({
      agents: [cost],
      pr: hasExisting ? existing : null,
      reads: hasExisting
        ? [
            { state: "open" },
            {
              state: "open",
              checks: [{ name: "CI", status: "success" }],
              mergeability: "conflicting",
            },
          ]
        : [],
    });
    const result = run(h.w, null, null);
    await h.asking;
    assert.isFalse(
      h.calls.some((call) => call[0] === "start"),
      "no gate before the decision",
    );
    assert.isNull(h.memory.get("sync-direction"), "no invented direction while blocked");
    assert.match(
      String((argumentOf(h.calls, "ask", 2) as { question: string }).question),
      /Issue #999/,
    );
    h.answer("Reassess the provider fixes; keep backend replacements.");
    assert.match(String(await result), /cost-blocked/);
    assert.strictEqual(
      h.memory.get("sync-direction"),
      "Reassess the provider fixes; keep backend replacements.",
    );
    assert.isFalse(
      h.calls.some((call) => call[0] === "start"),
      "no gate after cost-blocked result",
    );
    assert.isFalse(
      h.calls.some((call) => call[0] === "notify"),
      "no redundant push after the Blocker answer",
    );
    cases++;
  }

  {
    const h = makeHost({
      agents: [cost],
      pr: existing,
      reads: [
        { state: "open" },
        {
          state: "open",
          checks: [{ name: "CI", status: "pending" }],
          mergeability: "conflicting",
        },
      ],
    });
    const result = run(h.w, null, null);
    await h.asking;
    assert.isFalse(
      h.calls.some((call) => call[0] === "wait"),
      "pending CI cannot delay a known merge conflict",
    );
    assert.isFalse(
      /checks failed:/.test(String((argumentOf(h.calls, "agent", 2) as { prompt: string }).prompt)),
    );
    assert.isFalse(h.calls.some((call) => call[0] === "start"));
    h.answer("Reassess this conflict.");
    await result;
    cases++;
  }

  {
    const h = makeHost({
      agents: [cost],
      pr: existing,
      reads: [
        { state: "open" },
        {
          state: "open",
          checks: [
            { name: "WaitingJob", status: "pending" },
            { name: "BrokenJob", status: "failure" },
          ],
          mergeability: "conflicting",
        },
      ],
    });
    const result = run(h.w, null, null);
    await h.asking;
    const prompt = String((argumentOf(h.calls, "agent", 2) as { prompt: string }).prompt);
    assert.match(prompt, /checks failed: BrokenJob/);
    assert.isFalse(/WaitingJob/.test(prompt));
    assert.isFalse(h.calls.some((call) => call[0] === "start"));
    h.answer("Fix the real failure and reassess conflicts.");
    await result;
    cases++;
  }

  {
    const h = makeHost({
      agents: [],
      pr: existing,
      reads: [
        { state: "open" },
        {
          state: "open",
          checks: [{ name: "CI", status: "pending" }],
          mergeability: "mergeable",
        },
        { state: "merged" },
      ],
    });
    await run(h.w, null, null);
    assert.isFalse(
      h.calls.some((call) => call[0] === "agent"),
      "non-conflicting PR still waits for CI",
    );
    assert.strictEqual(h.calls.filter((call) => call[0] === "wait").length, 1);
    assert.isFalse(
      h.calls.some((call) => call[0] === "start"),
      "pending checks never reach the merge gate",
    );
    cases++;
  }

  for (const hasExisting of [false, true]) {
    const h = makeHost({
      agents: [
        hasExisting
          ? { text: "Fixed." }
          : { text: "RESULT: up-to-date", pullRequest: null, threadId: "new-thread" },
      ],
      pr: hasExisting ? existing : null,
      direction: "Only reassess the provider fixes.",
      reads: hasExisting
        ? [
            { state: "open" },
            { state: "open", checks: [{ name: "CI", status: "failure" }] },
            { state: "merged" },
          ]
        : [],
    });
    await run(h.w, null, null);
    assert.match(
      String((argumentOf(h.calls, "agent", 2) as { prompt: string }).prompt),
      /Only reassess the provider fixes/,
    );
    assert.isNull(h.memory.get("sync-direction"));
    assert.isFalse(h.calls.some((call) => call[0] === "ask"));
    cases++;
  }

  {
    const h = makeHost({
      agents: [{ text: "Applied the decision." }],
      pr: existing,
      direction: "Reassess before merging.",
      reads: [
        { state: "open" },
        { state: "open", checks: [{ name: "CI", status: "success" }] },
        { state: "merged" },
      ],
    });
    await run(h.w, null, null);
    assert.match(
      String((argumentOf(h.calls, "agent", 2) as { prompt: string }).prompt),
      /Reassess before merging/,
    );
    assert.isFalse(
      h.calls.some((call) => call[0] === "start"),
      "green CI cannot bypass pending human direction",
    );
    assert.isNull(h.memory.get("sync-direction"));
    cases++;
  }

  {
    const h = makeHost({
      agents: [],
      pr: existing,
      direction: "Only for this PR.",
      reads: [{ state: "open" }, { state: "merged" }],
    });
    await run(h.w, null, null);
    assert.isNull(
      h.memory.get("sync-direction"),
      "finished PR cannot leak its direction to a future sync",
    );
    cases++;
  }

  {
    const h = makeHost({ agents: [], direction: "Keep until an agent returns." });
    h.w.agent = async () => {
      throw new Error("provider unavailable");
    };
    await expect(run(h.w, null, null)).rejects.toThrow("provider unavailable");
    assert.strictEqual(h.memory.get("sync-direction"), "Keep until an agent returns.");
    cases++;
  }

  assert.strictEqual(cases, 10);
});
