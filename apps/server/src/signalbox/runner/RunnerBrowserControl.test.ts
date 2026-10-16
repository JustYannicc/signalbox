import type { CDPSession } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_WAIT_MS,
  DRIVER_IDLE_MS,
  IDLE_HAND_BACK,
  makeTabControl,
  PAYMENT_WAITING,
  PERSON_DRIVING,
  type Timer,
} from "./RunnerBrowserControl.ts";

/**
 * Who drives a tab of the agent's browser (#587), with the tab and its
 * clock faked: the order things happen in is what's under test.
 */

const setup = () => {
  const log: Array<string> = [];
  const listeners = new Set<() => void>();
  const record = (entry: string) => {
    log.push(entry);
    for (const listener of listeners) listener();
  };
  /** Resolves once `entry` is in the log. */
  const logged = (entry: string) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (!log.includes(entry)) return;
        listeners.delete(check);
        resolve();
      };
      listeners.add(check);
      check();
    });
  const cdp = {
    send: async (method: string, params: Record<string, string | undefined>) => {
      record([method, params.type, params.key ?? params.text].filter(Boolean).join(" "));
      return {};
    },
  } as unknown as CDPSession;
  const timers = new Set<{ readonly run: () => void; readonly ms: number }>();
  const timer: Timer = (run, ms) => {
    const entry = { run, ms };
    timers.add(entry);
    return () => void timers.delete(entry);
  };
  const fire = (ms: number) => {
    for (const entry of timers)
      if (entry.ms === ms) {
        timers.delete(entry);
        entry.run();
      }
  };
  const control = makeTabControl<string>({
    open: async () => ({ cdp: () => cdp, release: () => record("released") }),
    timer,
    changed: (handedBack) =>
      record(
        handedBack === null ? "taken" : `handed back by ${handedBack.viewer}: ${handedBack.notice}`,
      ),
    settle: async () => record("person step"),
  });
  return { control, log, record, logged, fire };
};

const keyDown = {
  _tag: "key",
  action: "down",
  key: "Shift",
  code: "ShiftLeft",
  modifiers: 8,
} as const;

describe("a tab's control", () => {
  it("still sends input that was queued when the person hands back", async () => {
    const { control, log, logged } = setup();
    control.take("ada");
    control.drive("ada", { _tag: "text", text: "Signalbox" });
    control.handBack(null);
    await logged("released");
    expect(log.indexOf("Input.insertText Signalbox")).toBeGreaterThan(-1);
    expect(log.indexOf("Input.insertText Signalbox")).toBeLessThan(log.indexOf("released"));
  });

  it("lets one viewer drive, and hands back after two minutes without input", async () => {
    const { control, log, logged, fire } = setup();
    expect(control.take("ada")).toBe(true);
    expect(control.take("grace")).toBe(false);
    expect(control.holder()).toBe("ada");

    // Grace's input never reaches the tab; a key Ada still holds is let go on hand-back.
    control.drive("grace", { _tag: "text", text: "nope" });
    control.drive("ada", keyDown);
    await logged("Input.dispatchKeyEvent rawKeyDown Shift");
    fire(DRIVER_IDLE_MS);
    await logged("released");

    expect(log).toEqual([
      "taken",
      "Input.dispatchKeyEvent rawKeyDown Shift",
      `handed back by ada: ${IDLE_HAND_BACK}`,
      "Input.dispatchKeyEvent keyUp Shift",
      "person step",
      "released",
    ]);
    expect(control.holder()).toBe(null);
    expect(control.generation()).toBe(2);
  });

  it("drains the agent's running action before the person's input, and the agent waits for the hand-back", async () => {
    const { control, log, record, logged, fire } = setup();
    const running = await control.agentTurn();
    control.take("ada");
    control.drive("ada", { _tag: "text", text: "hi" });
    record("agent done");
    running();
    await logged("Input.insertText hi");

    const waiting = control.agentTurn().then((done) => {
      record("agent's turn");
      done();
    });
    control.handBack(null);
    await waiting;
    expect(log).toEqual([
      "taken",
      "agent done",
      "Input.insertText hi",
      "handed back by ada: null",
      "person step",
      "released",
      "agent's turn",
    ]);

    control.take("ada");
    const refused = control.agentTurn();
    fire(AGENT_WAIT_MS);
    await expect(refused).rejects.toThrow(PERSON_DRIVING);
  });

  it("keeps a tab handed to the person until the hold ends, whoever drives it meanwhile", async () => {
    const { control, log, record, logged, fire } = setup();
    control.hold(true);
    expect(control.personal()).toBe(true);

    // Nobody drives yet, and still the agent waits; it hears why once it waited long enough.
    const refused = control.agentTurn();
    fire(AGENT_WAIT_MS);
    await expect(refused).rejects.toThrow(PAYMENT_WAITING);

    // Ada pays and lets go: the tab stays with the person.
    const waiting = control.agentTurn().then((done) => {
      record("agent's turn");
      done();
    });
    expect(control.take("ada")).toBe(true);
    control.drive("ada", { _tag: "text", text: "4242" });
    control.handBack(null);
    await logged("released");
    expect(control.personal()).toBe(true);
    expect(control.take("grace")).toBe(true);

    // Done: whoever drives lets go, and the agent goes on once their input settled.
    control.hold(false);
    await waiting;
    expect(log).toEqual([
      "taken",
      "taken",
      "handed back by ada: null",
      "Input.insertText 4242",
      "person step",
      "released",
      "taken",
      "handed back by grace: null",
      "person step",
      "released",
      "agent's turn",
    ]);
    expect(control.personal()).toBe(false);
  });
});
