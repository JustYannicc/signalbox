// @effect-diagnostics globalDate:off globalTimers:off - Owns Playwright input outside the Effect runtime.
import type { AgentBrowserDrivingInput } from "@t3tools/contracts/signalboxPreviews";
import { constVoid } from "effect/Function";
import type { CDPSession } from "playwright-core";

import * as ServerBrowserPage from "../../preview/ServerBrowserPage.ts";
import { type LocateNode, makeInputDriver } from "./RunnerBrowserInput.ts";

/**
 * Who drives one tab of the agent's browser (#587): the agent, or the one
 * viewer who took it over. Taking over reserves the tab at once, but the
 * person's input waits for the agent's running actions, as upstream's
 * `SessionControl` drains them; the agent's next actions wait for the
 * hand-back, failing after `AGENT_WAIT_MS`. The tab returns to the agent on
 * `handBack`: the viewer let go or left, the tab closed, or two minutes
 * passed without input.
 *
 * A tab can also be handed to the person outright (`hold`, #579): the agent
 * waits on it while nobody drives too, any of the person's viewers may take
 * it, and handing it back leaves it with the person until the hold ends.
 */

/** Codex fails an MCP call after 60 seconds; the agent hears why before that. */
export const AGENT_WAIT_MS = 45_000;
export const DRIVER_IDLE_MS = 2 * 60_000;

export const PERSON_DRIVING = "The person is driving this tab. Call it again to keep waiting.";
export const IDLE_HAND_BACK = "Handed back after 2 minutes without input.";
export const PAYMENT_WAITING =
  "The person is finishing a payment in this tab. Call needs_you_payment to wait for them.";

/** Runs `run` after `ms`; returns how to cancel it. */
export type Timer = (run: () => void, ms: number) => () => void;

/** A `Timer` on Node's clock that never keeps the process alive. */
export const defaultTimer: Timer = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** The tab, opened for a person to drive; its browser stays connected until `release`. */
export interface DrivenTab {
  /** The tab's CDP session now, or null once it closed. */
  readonly cdp: () => CDPSession | null;
  readonly release: () => void;
}

export interface TabControl<V> {
  readonly holder: () => V | null;
  /** Counts every change of hands, as `preview_status` reports it. */
  readonly generation: () => number;
  /** False when another viewer holds the tab. */
  readonly take: (viewer: V) => boolean;
  /** `viewer`'s input, when it holds the tab. */
  readonly drive: (viewer: V, input: AgentBrowserDrivingInput) => void;
  /** Gives the tab back to the agent, telling the holder `notice` if any. */
  readonly handBack: (notice: string | null) => void;
  /** Waits for the agent's turn, then marks its action until the returned `done`. */
  readonly agentTurn: () => Promise<() => void>;
  /** The agent waits on the tab: a person drives it, holds it, or is handing it back. */
  readonly personal: () => boolean;
  /** Hands the tab to the person until called with false, which gives it back; false when nothing changed. */
  readonly hold: (on: boolean) => boolean;
}

interface Driving<V> {
  readonly viewer: V;
  readonly takenAt: string;
  readonly opened: Promise<DrivenTab | null>;
  readonly input: ReturnType<typeof makeInputDriver>;
  /** Inputs run one after another, after the agent's running actions. */
  tail: Promise<void>;
  cancelIdle: () => void;
}

export const makeTabControl = <V>(options: {
  /** Opens the tab to drive, reconnecting it if it rests. */
  readonly open: () => Promise<DrivenTab>;
  readonly timer: Timer;
  /** Control changed hands: taken, or handed back by `viewer`, with `notice` for them. */
  readonly changed: (
    handedBack: { readonly viewer: V; readonly notice: string | null } | null,
  ) => void;
  /** After the hand-back's input settled, before the browser may let go: the person's step ends. */
  readonly settle: (takenAt: string, cdp: CDPSession | null) => Promise<void>;
  /** Finds the element a pointer input aims at; without it, pointers go by coordinates. */
  readonly locate?: LocateNode;
}): TabControl<V> => {
  let driving: Driving<V> | null = null;
  /** The agent waits while a person drives and until the hand-back settled. */
  let blocked = false;
  /** Handed to the person (`hold`): handing back keeps the agent waiting. */
  let held = false;
  /** Hand-backs whose input hasn't settled yet. */
  let settling = 0;
  let generation = 0;
  let agents = 0;
  const turns = new Set<() => void>();
  const drains = new Set<() => void>();

  const drained = () =>
    new Promise<void>((resolve) => {
      if (agents === 0) return resolve();
      drains.add(resolve);
    });

  const armIdle = (current: Driving<V>) => {
    current.cancelIdle();
    current.cancelIdle = options.timer(() => {
      if (driving === current) handBack(IDLE_HAND_BACK);
    }, DRIVER_IDLE_MS);
  };

  const unblock = () => {
    blocked = false;
    for (const wake of turns) wake();
    turns.clear();
  };

  function handBack(notice: string | null) {
    const current = driving;
    if (current === null) return;
    driving = null;
    generation += 1;
    settling += 1;
    current.cancelIdle();
    void current.tail
      .then(async () => {
        const opened = await current.opened;
        const cdp = opened?.cdp() ?? null;
        if (cdp !== null) await current.input.release(cdp);
        await options.settle(current.takenAt, cdp);
        opened?.release();
      })
      .catch(constVoid)
      .finally(() => {
        settling -= 1;
        if (driving === null && !held && settling === 0) unblock();
      });
    options.changed({ viewer: current.viewer, notice });
  }

  return {
    holder: () => driving?.viewer ?? null,
    generation: () => generation,
    take: (viewer) => {
      if (driving !== null) {
        if (driving.viewer !== viewer) return false;
        armIdle(driving);
        return true;
      }
      const opening = options.open();
      const current: Driving<V> = {
        viewer,
        takenAt: new Date().toISOString(),
        opened: opening.catch(() => null),
        input: makeInputDriver(options.locate),
        tail: Promise.resolve(),
        cancelIdle: constVoid,
      };
      current.tail = current.opened.then(drained);
      driving = current;
      blocked = true;
      generation += 1;
      armIdle(current);
      opening.catch((cause: unknown) => {
        if (driving === current) handBack(cause instanceof Error ? cause.message : String(cause));
      });
      options.changed(null);
      return true;
    },
    drive: (viewer, input) => {
      const current = driving;
      if (current === null || current.viewer !== viewer) return;
      armIdle(current);
      // Queued while they held the tab, so it runs even if they hand back
      // first: the hand-back waits for this queue before letting go.
      current.tail = current.tail
        .then(async () => {
          const cdp = (await current.opened)?.cdp() ?? null;
          if (cdp !== null) await current.input.dispatch(cdp, input);
        })
        .catch(constVoid);
    },
    handBack,
    agentTurn: async () => {
      if (blocked)
        await new Promise<void>((resolve, reject) => {
          const wake = () => {
            cancel();
            resolve();
          };
          const cancel = options.timer(() => {
            turns.delete(wake);
            reject(
              new ServerBrowserPage.ServerBrowserOperationError(
                "PreviewAutomationExecutionError",
                held ? PAYMENT_WAITING : PERSON_DRIVING,
              ),
            );
          }, AGENT_WAIT_MS);
          turns.add(wake);
        });
      agents += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        agents -= 1;
        if (agents > 0) return;
        for (const resolve of drains) resolve();
        drains.clear();
      };
    },
    personal: () => blocked,
    hold: (on) => {
      if (on === held) return false;
      held = on;
      // Whoever drives lets go, and the tab is the agent's once their input settled.
      if (!on && driving !== null) {
        handBack(null);
        return true;
      }
      generation += 1;
      if (on) blocked = true;
      else if (settling === 0) unblock();
      options.changed(null);
      return true;
    },
  };
};
