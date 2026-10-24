// @vitest-environment jsdom
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { SignalboxAsk, SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { v2Projection } from "@t3tools/client-runtime/state/orchestration-v2-test-fixtures";

const { state, send } = vi.hoisted(() => ({
  state: { allowed: true, projection: null as OrchestrationV2ThreadProjection | null },
  send: vi.fn((_input: unknown): Promise<AtomCommandResult<void, Error>> =>
    Promise.resolve(AsyncResult.success(undefined)),
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/signalboxAsks", () => ({
  signalboxAskCommand: { permissionAtom: () => null },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => send }));
vi.mock("../../state/use-thread-detail", () => ({
  useThreadProjection: () => (state.projection ? { projection: state.projection } : null),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "answer-command" }));
vi.mock("react-native-webview", () => ({ WebView: () => null }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../state/assets", () => ({ useAssetUrlState: () => ({ _tag: "Loading" }) }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", select: (options: { ios?: unknown; default?: unknown }) => options.ios },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    editable,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
    editable?: boolean;
  }) => (
    <textarea
      aria-label={accessibilityLabel}
      value={value}
      disabled={editable === false}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      onChange={() => {}}
    />
  ),
}));

import { nativeFontStyle } from "../asks/AskChoices";
import { SignalboxAsksCard } from "./SignalboxAsksCard";

const now = "2026-10-17T12:00:00.000Z";
const question = (id: string): SignalboxAskQuestion => ({
  id,
  question: `Question ${id}?`,
  why: "Need your decision",
  unblocks: "Delivery",
  decisionOwner: "You",
  recommendation: "Small",
  options: [{ label: "Small", value: { size: 1 } }],
  blocking: true,
  surface: { kind: "kit", component: "choice" },
});
const ask: SignalboxAsk = {
  id: "ask",
  kind: "blocker",
  source: { kind: "agent" },
  status: "pending",
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
const threadRef = {
  environmentId: EnvironmentId.make("mobile"),
  threadId: ThreadId.make("thread"),
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.projection = { ...v2Projection, thread: { ...v2Projection.thread, asks: [ask] } };
  send.mockReset();
  send.mockResolvedValue(AsyncResult.success(undefined));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () =>
  act(() =>
    root.render(
      <SignalboxAsksCard threadRef={threadRef} maxHeight={300} onInputFocusChange={() => {}} />,
    ),
  );
async function typeAnswer(id: string, text: string) {
  const input = container.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="Answer or comment: Question ${id}?"]`,
  )!;
  await act(() => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  expect(found).toBeDefined();
  return found!;
}

describe("mobile durable ask answering", () => {
  it("answers an untouched slider in words only, and defers the other kit control", async () => {
    const kit = (
      id: string,
      surface: SignalboxAskQuestion["surface"],
      options: SignalboxAskQuestion["options"] = [],
    ): SignalboxAskQuestion => ({ ...question(id), options, recommendation: null, surface });
    const kitAsk: SignalboxAsk = {
      ...ask,
      questions: [
        kit("one", { kind: "kit", component: "slider", props: { min: 0, max: 5, step: 1 } }),
        kit("two", { kind: "kit", component: "ranking" }, [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
        ]),
      ],
    };
    state.projection = { ...v2Projection, thread: { ...v2Projection.thread, asks: [kitAsk] } };
    await render();
    await typeAnswer("one", "Somewhere in the middle");
    await act(() => button("Save answers, defer remainder").click());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          answers: [{ questionId: "one", value: null, comment: "Somewhere in the middle" }],
          deferredQuestionIds: ["two"],
        }),
      }),
    );
  });

  it("sends a round comment without inventing an answer", async () => {
    await render();
    const input = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Round comment (optional)"]',
    )!;
    await act(() => {
      input.value = "Need another day";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => button("Save answers, defer remainder").click());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          answers: [],
          deferredQuestionIds: ["one", "two"],
          comment: "Need another day",
        }),
      }),
    );
  });

  it("sends free text and defers the unanswered remainder after a turn has stopped", async () => {
    await render();
    await typeAnswer("one", "My answer");
    await act(() => button("Save answers, defer remainder").click());
    expect(send).toHaveBeenCalledWith({
      environmentId: "mobile",
      input: {
        type: "thread.ask.answer",
        commandId: "answer-command",
        threadId: "thread",
        askId: "ask",
        round: 2,
        answers: [{ questionId: "one", value: "My answer" }],
        deferredQuestionIds: ["two"],
        answeredBy: { kind: "person", personId: "local-user" },
      },
    });
  });

  it("keeps a structured option and the person's free-text comment together", async () => {
    await render();
    await act(() => button("Small").click());
    await typeAnswer("one", "Keep it small");
    await act(() => button("Save answers, defer remainder").click());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          answers: [{ questionId: "one", value: { size: 1 }, comment: "Keep it small" }],
          deferredQuestionIds: ["two"],
        }),
      }),
    );
  });

  it("defers every question explicitly and cannot double-submit while the reply is in flight", async () => {
    let finish!: (result: AtomCommandResult<void, Error>) => void;
    send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await typeAnswer("one", "Unfinished draft");
    const defer = button("Defer all");
    await act(() => {
      defer.click();
      defer.click();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ answers: [], deferredQuestionIds: ["one", "two"] }),
      }),
    );
    await act(() => finish(AsyncResult.success(undefined)));
  });

  it("retains the draft for retry after a server failure and stops on permission revocation", async () => {
    send.mockResolvedValueOnce(AsyncResult.fail(new Error("Round changed. Try again.")));
    await render();
    await typeAnswer("one", "Keep my answer");
    await act(() => button("Save answers, defer remainder").click());
    state.allowed = false;
    await render();
    await act(() => button("Save answers, defer remainder").click());
    expect(send).toHaveBeenCalledTimes(1);
    state.allowed = true;
    await render();
    await act(() => button("Save answers, defer remainder").click());
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          answers: [{ questionId: "one", value: "Keep my answer" }],
        }),
      }),
    );
  });
});

it("maps generic fonts but never takes a font name from Object's prototype", () => {
  expect(nativeFontStyle("monospace")).toEqual({ fontFamily: "Menlo" });
  expect(nativeFontStyle("system-ui")).toBeUndefined();
  // A valid font name that is also an Object.prototype key stays a plain font name.
  expect(nativeFontStyle("constructor")).toEqual({ fontFamily: "constructor" });
  expect(nativeFontStyle("toString")).toEqual({ fontFamily: "toString" });
});
