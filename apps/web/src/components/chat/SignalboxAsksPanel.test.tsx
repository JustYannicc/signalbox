import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SignalboxAsk, SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { state, run } = vi.hoisted(() => ({
  state: { allowed: true },
  run: vi.fn(async (_input: unknown) => ({ value: undefined })),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/signalboxAsks", () => ({
  signalboxAskCommand: { permissionAtom: () => null },
}));
vi.mock("../../account/accountSession", () => ({
  readAccountSession: () => ({ account: { id: "person-1" } }),
}));
vi.mock("../automations/useAutomationCommand", () => ({
  useAutomationCommand: () => ({ run, busy: false }),
}));

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
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
  surface: { kind: "html", html: "<script>throw 'unsafe'</script>" },
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
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  state.allowed = true;
  run.mockClear();
});

async function mount(currentAsk = ask) {
  await act(() => {
    renderer = create(
      <SignalboxAsksPanel asks={[currentAsk]} requests={[]} threadRef={threadRef} />,
    );
  });
}
async function click(label: string) {
  const button = renderer!.root
    .findAllByType(Button)
    .find((candidate) => candidate.props.children === label);
  expect(button).toBeDefined();
  await act(() => button!.props.onClick());
}

describe("durable ask answering", () => {
  it("submits a partial answer with the current round, identity, and deferred remainder", async () => {
    await mount();
    await act(() =>
      renderer!.root
        .findAllByType(Textarea)[0]!
        .props.onChange({ currentTarget: { value: "My answer" } }),
    );
    await act(() =>
      renderer!.root
        .findAllByType(Textarea)[2]!
        .props.onChange({ currentTarget: { value: "Revisit the rest tomorrow" } }),
    );
    await click("Save answers, defer remainder");
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
    await mount();
    await act(() =>
      renderer!.root
        .findAllByType(Textarea)[0]!
        .props.onChange({ currentTarget: { value: "Unfinished draft" } }),
    );
    await click("Defer all");
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
    await mount();
    await act(() =>
      renderer!.root
        .findAllByType(Textarea)[0]!
        .props.onChange({ currentTarget: { value: "Private to the old thread" } }),
    );
    const otherThread = { ...threadRef, threadId: ThreadId.make("other-thread") };
    await act(() =>
      renderer!.update(<SignalboxAsksPanel asks={[ask]} requests={[]} threadRef={otherThread} />),
    );
    await act(() =>
      renderer!.root
        .findAllByType(Textarea)[1]!
        .props.onChange({ currentTarget: { value: "New thread answer" } }),
    );
    await click("Save answers, defer remainder");
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

  it("stops submission when permission is revoked", async () => {
    await mount();
    await act(() =>
      renderer!.root
        .findAllByType(Textarea)[0]!
        .props.onChange({ currentTarget: { value: "My answer" } }),
    );
    state.allowed = false;
    await act(() =>
      renderer!.update(<SignalboxAsksPanel asks={[ask]} requests={[]} threadRef={threadRef} />),
    );
    await click("Save answers, defer remainder");
    await click("Defer all");
    expect(run).not.toHaveBeenCalled();
  });
});
