import "../../index.css";

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

describe("ComposerPrimaryActions stop pending state", () => {
  const onInterrupt = vi.fn();
  const onResume = vi.fn();
  const onSubmitMessage = vi.fn();
  function runningProps(isRunning: boolean, canOperateThread = true) {
    return {
      compact: true,
      canOperateThread,
      pendingAction: null,
      isRunning,
      canInterrupt: isRunning && canOperateThread,
      canResume: !isRunning,
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
    isRunning: boolean,
    canOperateThread = true,
    overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {},
  ) =>
    act(() =>
      root.render(
        createElement(ComposerPrimaryActions, {
          ...runningProps(isRunning, canOperateThread),
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
    Object.assign(container.style, {
      display: "flex",
      justifyContent: "flex-end",
      alignItems: "center",
      width: "400px",
      height: "48px",
    });
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

  it.each(["Resume thread", "Compact and send"])(
    "keeps the Stop target inert until the separate %s action starts a new run",
    (actionLabel) => {
      const { x, y, width, height } = slot().getBoundingClientRect();
      const buttonAtStop = () =>
        document.elementFromPoint(x + width / 2, y + height / 2)?.closest("button");

      clickStop();
      expect(buttonAtStop()).toBe(slot());
      expect(slot()).toMatchObject({ ariaLabel: "Stopping", disabled: true });
      clickStop();
      expect(onInterrupt).toHaveBeenCalledTimes(1);

      render(false);
      if (actionLabel === "Compact and send") {
        render(false, true, {
          promptHasText: true,
          hasSendableContent: true,
          compactBeforeSendTokens: 50_000,
        });
      }
      act(() => vi.advanceTimersByTime(20_000));
      expect(buttonAtStop()).toBe(slot());
      expect(slot()).toMatchObject({ ariaLabel: "Stopped", disabled: true });
      act(() => {
        for (let i = 0; i < 3; i++) buttonAtStop()!.click();
      });
      expect(onInterrupt).toHaveBeenCalledTimes(1);
      expect(onResume).not.toHaveBeenCalled();
      expect(onSubmitMessage).not.toHaveBeenCalled();

      const action = container.querySelector<HTMLButtonElement>(
        `button[aria-label="${actionLabel}"]`,
      )!;
      expect(action.disabled).toBe(false);
      act(() => action.click());
      expect(actionLabel === "Resume thread" ? onResume : onSubmitMessage).toHaveBeenCalledTimes(1);
      render(true);
      expect(slot()).toMatchObject({ ariaLabel: "Stop generation", disabled: false });
      clickStop();
      expect(onInterrupt).toHaveBeenCalledTimes(2);
      expect(slot()).toMatchObject({ ariaLabel: "Stopping", disabled: true });
    },
  );

  it.each([false, true])("allows retry at 10s and protects a late landing (retry: %s)", (retry) => {
    clickStop();
    act(() => vi.advanceTimersByTime(9_999));
    expect(slot()).toMatchObject({ ariaLabel: "Stopping", disabled: true });
    act(() => vi.advanceTimersByTime(1));
    expect(slot()).toMatchObject({ ariaLabel: "Stop generation", disabled: false });

    if (retry) {
      clickStop();
      expect(onInterrupt).toHaveBeenCalledTimes(2);
      expect(slot()).toMatchObject({ ariaLabel: "Stopping", disabled: true });
    }
    render(false);
    clickStop();
    expect(slot()).toMatchObject({ ariaLabel: "Stopped", disabled: true });
    expect(onInterrupt).toHaveBeenCalledTimes(retry ? 2 : 1);
    expect(onResume).not.toHaveBeenCalled();
    expect(onSubmitMessage).not.toHaveBeenCalled();
  });

  it("does not read a lost operate permission as a landed stop", () => {
    clickStop();
    render(true, false);
    clickStop();
    render(true);

    expect(slot()).toMatchObject({ ariaLabel: "Stopping", disabled: true });
    clickStop();
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="Resume thread"]')).toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    clickStop();
    expect(onInterrupt).toHaveBeenCalledTimes(2);
  });
});
