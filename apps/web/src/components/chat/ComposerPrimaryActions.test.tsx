// @vitest-environment jsdom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const stageArtworkState = vi.hoisted(() => ({
  mode: "none" as "artwork" | "none",
  variant: null as "nightly" | "dev" | null,
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => stageArtworkState.mode,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: ({ variant }: { variant: string }) => `stage-${variant}`,
  useSidebarStageBackdropVariant: (enabled = true) => (enabled ? stageArtworkState.variant : null),
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

function renderPendingActions(isRunning: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      canOperateThread: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      canInterrupt: isRunning,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderSendButton(sendDisabledReason: string | null = null) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      canOperateThread: true,
      pendingAction: null,
      isRunning: false,
      canInterrupt: false,
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

afterEach(() => {
  stageArtworkState.mode = "none";
  stageArtworkState.variant = null;
});

describe("ComposerPrimaryActions", () => {
  it("disables and labels the send button while feedback is uploading", () => {
    const markup = renderSendButton("Sending feedback");

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Sending feedback"');
  });

  it("offers Stop generation while a running turn is waiting for user input", () => {
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"');
  });

  it("does not offer Stop generation for a pending request without a running turn", () => {
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"');
  });

  it("renders stage artwork inside the send button when artwork identification is active", () => {
    stageArtworkState.mode = "artwork";
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).toContain("stage-nightly");
  });

  it("hides stage artwork when artwork identification is inactive", () => {
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).not.toContain("stage-nightly");
  });
});

describe("ComposerPrimaryActions stop pending state", () => {
  const onInterrupt = vi.fn();
  const onResume = vi.fn();
  function runningProps(canInterrupt: boolean) {
    return {
      compact: true,
      canOperateThread: true,
      pendingAction: null,
      isRunning: canInterrupt,
      canInterrupt,
      canResume: !canInterrupt,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt,
      onResume,
      onImplementPlanInNewThread: () => {},
    };
  }

  let container: HTMLDivElement;
  let root: Root;
  const render = (canInterrupt: boolean) =>
    act(() => root.render(createElement(ComposerPrimaryActions, runningProps(canInterrupt))));
  const slot = () => [...container.querySelectorAll("button")].at(-1)!;
  const clickStop = () => act(() => slot().click());

  beforeEach(() => {
    onInterrupt.mockClear();
    onResume.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    render(true);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps repeat Stop clicks inert after the stop lands, with a separate Resume target", () => {
    clickStop();
    expect(slot()).toMatchObject({ ariaLabel: "Stopping", disabled: true });

    render(false);
    act(() => vi.advanceTimersByTime(1_100));
    for (let i = 0; i < 20; i++) clickStop();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
    expect(slot()).toMatchObject({ ariaLabel: "Stopped", disabled: true });

    const resume = container.querySelector<HTMLButtonElement>('button[aria-label="Resume thread"]');
    expect(resume?.disabled).toBe(false);
    act(() => resume?.click());
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("enables Stop at once for a new run started after the stop lands", () => {
    clickStop();
    render(false);
    render(true);

    expect(slot()).toMatchObject({ ariaLabel: "Stop generation", disabled: false });
  });

  it("re-enables Stop when the stop never lands", () => {
    clickStop();

    act(() => vi.advanceTimersByTime(10_000));
    expect(slot()).toMatchObject({ ariaLabel: "Stop generation", disabled: false });
  });

  it("keeps repeat Stop clicks away from Resume when the stop lands after the timeout", () => {
    clickStop();
    act(() => vi.advanceTimersByTime(10_000));

    render(false);
    for (let i = 0; i < 20; i++) clickStop();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
    expect(slot()).toMatchObject({ ariaLabel: "Stopped", disabled: true });
  });

  it("sends Stop again after the timeout and waits for it to land", () => {
    clickStop();
    act(() => vi.advanceTimersByTime(10_000));

    clickStop();
    expect(onInterrupt).toHaveBeenCalledTimes(2);
    expect(slot()).toMatchObject({ ariaLabel: "Stopping", disabled: true });
  });
});
