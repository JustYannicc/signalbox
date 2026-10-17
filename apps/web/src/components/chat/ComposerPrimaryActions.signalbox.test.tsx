// @vitest-environment jsdom
// Temporary carry of upstream #20809 on Signalbox's jsdom harness.
// Delete once #20809 lands and the upstream sync brings its browser tests.
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import type { ComposerSendLock } from "./sendLock/composerSendLock";
import { SEND_LOCKED_REASON } from "./sendLock/composerSendLockStore";

describe("ComposerPrimaryActions stop pending state", () => {
  const onInterrupt = vi.fn();
  const onResume = vi.fn();
  const onSubmitMessage = vi.fn();
  function runningProps(canInterrupt: boolean, canOperateThread = true) {
    return {
      compact: true,
      canOperateThread,
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
      onSubmitMessage,
      onImplementPlanInNewThread: () => {},
    };
  }

  let container: HTMLDivElement;
  let root: Root;
  const render = (
    canInterrupt: boolean,
    canOperateThread = true,
    {
      threadId = "thread-a",
      ...overrides
    }: Partial<ComponentProps<typeof ComposerPrimaryActions>> & { threadId?: string } = {},
  ) =>
    act(() =>
      root.render(
        createElement(ComposerPrimaryActions, {
          ...runningProps(canInterrupt, canOperateThread),
          key: threadId,
          ...overrides,
        }),
      ),
    );
  const slot = () => [...container.querySelectorAll("button")].at(-1)!;
  const clickStop = () => act(() => slot().click());

  beforeEach(() => {
    onInterrupt.mockClear();
    onResume.mockClear();
    onSubmitMessage.mockClear();
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

  it("keeps the stopped slot when typed text swaps Resume for Submit", () => {
    clickStop();
    render(false);
    render(false, true, {
      promptHasText: true,
      hasSendableContent: true,
      compactBeforeSendTokens: 50_000,
    });

    for (let i = 0; i < 20; i++) clickStop();
    expect(onSubmitMessage).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
    expect(slot()).toMatchObject({ ariaLabel: "Stopped", disabled: true });
    expect(container.querySelector('button[aria-label="Compact and send"]')).not.toBeNull();
    expect(container.querySelector("[aria-pressed]")).not.toBeNull();
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

  it("does not read a lost operate permission as a landed stop", () => {
    clickStop();
    // ChatView folds the permission into canInterrupt, so a flap drops both.
    render(false, false);
    render(true);

    expect(slot()).toMatchObject({ ariaLabel: "Stopping", disabled: true });
    expect(container.querySelector('button[aria-label="Resume thread"]')).toBeNull();
  });

  it("keeps a pending Stop local to its thread instance", () => {
    clickStop();
    expect(slot()).toMatchObject({ ariaLabel: "Stopping", disabled: true });

    render(true, true, { threadId: "thread-b" });
    expect(slot()).toMatchObject({ ariaLabel: "Stop generation", disabled: false });
    clickStop();
    expect(onInterrupt).toHaveBeenCalledTimes(2);

    render(true, true, { threadId: "thread-a" });
    expect(slot()).toMatchObject({ ariaLabel: "Stop generation", disabled: false });
  });

  it("keeps the send lock's single target after Stop and restores Resume on unlock", () => {
    clickStop();
    let locked = true;
    const sendLock = (): ComposerSendLock => ({
      on: locked,
      locked,
      disabledReason: locked ? SEND_LOCKED_REASON : null,
      setLocked: (next) => {
        locked = next;
        render(false, true, { sendLock: sendLock() });
      },
    });
    render(false, true, { sendLock: sendLock() });

    const lockedButton = container.querySelector<HTMLButtonElement>(
      "button[data-chat-composer-send-locked]",
    );
    expect(lockedButton).not.toBeNull();
    expect(container.querySelector('button[aria-label="Stopped"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Resume thread"]')).toBeNull();
    act(() => lockedButton?.click());
    const unlock = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Unlock sending",
    );
    expect(unlock).toBeDefined();
    act(() => unlock?.click());

    expect(container.querySelector('button[aria-label="Resume thread"]')).toMatchObject({
      disabled: false,
    });
    for (let i = 0; i < 20; i++) clickStop();
    expect(slot()).toMatchObject({ ariaLabel: "Stopped", disabled: true });
    expect(onResume).not.toHaveBeenCalled();
  });
});
