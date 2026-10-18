import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SignalboxAsk, SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const { state, run } = vi.hoisted(() => ({
  state: { allowed: true },
  run: vi.fn(async (_input: unknown) => ({ value: undefined })),
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => state.allowed,
}));
vi.mock("../../state/signalboxAsks", () => ({
  signalboxAskCommand: { permissionAtom: () => null },
}));
vi.mock("../../account/accountSession", () => ({
  readAccountSession: () => ({ account: { id: "person-1" } }),
}));
vi.mock("../automations/useAutomationCommand", () => ({
  useAutomationCommand: () => ({ run, busy: false }),
}));

import { SignalboxAsksPanel } from "./SignalboxAsksPanel";

const now = "2026-10-16T12:00:00.000Z";
const question = (id: string): SignalboxAskQuestion => ({
  id,
  question: `Question ${id}?`,
  why: "Need your decision",
  unblocks: "Delivery",
  recommendation: "Small",
  options: [{ label: "Small", value: { size: 1 } }],
  blocking: true,
  decisionOwner: "You",
  surface: { kind: "html", html: "<p>Choose an answer below.</p>" },
});
const ask: SignalboxAsk = {
  id: "ask",
  kind: "blocker",
  status: "pending",
  source: { kind: "agent" },
  createdAt: now,
  updatedAt: now,
  questions: [question("one"), question("two")],
  rounds: [
    {
      number: 2,
      questionIds: ["one", "two"],
      answers: [],
      deferredQuestionIds: [],
      openedAt: now,
      closedAt: null,
    },
  ],
};
const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  state.allowed = true;
  run.mockClear();
});

const render = (currentAsk = ask, ref = threadRef) =>
  act(async () =>
    root.render(<SignalboxAsksPanel asks={[currentAsk]} requests={[]} threadRef={ref} />),
  );

const answerField = (id: string) =>
  container.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="Answer or comment: Question ${id}?"]`,
  )!;
const roundComment = () =>
  [...container.querySelectorAll("textarea")].find(
    (field) => field.labels?.[0]?.textContent === "Round comment (optional)",
  )!;
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found, label).toBeDefined();
  return found!;
};
const type = (field: HTMLTextAreaElement, text: string) => userEvent.type(field, text);

describe("durable ask answering", () => {
  it("submits a partial answer with the current round, identity, and deferred remainder", async () => {
    await render();
    await type(answerField("one"), "My answer");
    await type(roundComment(), "Revisit the rest tomorrow");
    await userEvent.click(button("Save answers, defer remainder"));
    expect(run).toHaveBeenCalledWith({
      environmentId: "env",
      input: {
        type: "thread.ask.answer",
        commandId: expect.any(String),
        threadId: "thread",
        askId: "ask",
        round: 2,
        answers: [{ questionId: "one", value: "My answer" }],
        deferredQuestionIds: ["two"],
        comment: "Revisit the rest tomorrow",
        answeredBy: { kind: "person", personId: "person-1" },
      },
    });
  });

  it("defers every question explicitly without submitting a draft as an answer", async () => {
    await render();
    await type(answerField("one"), "Unfinished draft");
    await userEvent.click(button("Defer all"));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          round: 2,
          answers: [],
          deferredQuestionIds: ["one", "two"],
        }),
      }),
    );
  });

  it("does not carry a draft to another thread with the same ask ID and round", async () => {
    await render();
    await type(answerField("one"), "Private to the old thread");
    await render(ask, { ...threadRef, threadId: ThreadId.make("other-thread") });
    expect(answerField("one").value).toBe("");
    await type(answerField("two"), "New thread answer");
    await userEvent.click(button("Save answers, defer remainder"));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          threadId: "other-thread",
          answers: [{ questionId: "two", value: "New thread answer" }],
          deferredQuestionIds: ["one"],
        }),
      }),
    );
  });

  it("sends the recommendation only when picked, with a comment, and defers untouched kit controls", async () => {
    const kitQuestion = (
      id: string,
      surface: SignalboxAskQuestion["surface"],
      changes: Partial<SignalboxAskQuestion> = {},
    ): SignalboxAskQuestion => ({ ...question(id), surface, ...changes });
    const kitAsk: SignalboxAsk = {
      ...ask,
      questions: [
        kitQuestion(
          "plan",
          { kind: "kit", component: "choices" },
          {
            options: [
              { label: "Small", value: { size: 1 } },
              { label: "Large", value: { size: 2 } },
            ],
            recommendation: { size: 2 },
          },
        ),
        kitQuestion(
          "budget",
          { kind: "kit", component: "slider", props: { min: 0, max: 10, step: 1 } },
          { options: [], recommendation: null },
        ),
      ],
      rounds: [{ ...ask.rounds[0]!, questionIds: ["plan", "budget"] }],
    };
    await render(kitAsk);
    // Nothing is chosen until the person acts; the slider rests unset.
    expect(button("Large").getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("Not set. Drag or use the arrow keys.");

    await userEvent.click(button("Use recommendation"));
    expect(button("Large").getAttribute("aria-pressed")).toBe("true");
    await type(answerField("plan"), "Only for this quarter");
    await userEvent.click(button("Save answers, defer remainder"));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          answers: [{ questionId: "plan", value: { size: 2 }, comment: "Only for this quarter" }],
          deferredQuestionIds: ["budget"],
        }),
      }),
    );
  });

  it("stops submission when permission is revoked", async () => {
    await render();
    await type(answerField("one"), "My answer");
    state.allowed = false;
    await render();
    const save = button("Save answers, defer remainder");
    const deferAll = button("Defer all");
    expect(save.disabled).toBe(true);
    expect(deferAll.disabled).toBe(true);
    // A disabled button swallows the click, as it would for a person.
    await act(async () => {
      save.click();
      deferAll.click();
    });
    expect(run).not.toHaveBeenCalled();
  });
});
