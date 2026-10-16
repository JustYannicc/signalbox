// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Owns Playwright pages outside the Effect runtime.
import * as NodeCrypto from "node:crypto";

import {
  AGENT_BROWSER_STEP_ACTIONS,
  type AgentBrowserHandoff,
  type AgentBrowserInput,
  type AgentBrowserStep,
  type AgentBrowserTab,
  type AgentBrowserUpdate,
} from "@t3tools/contracts/signalboxPreviews";
import { constVoid } from "effect/Function";
import type { CDPSession, Page } from "playwright-core";

import {
  defaultTimer,
  type DrivenTab,
  makeTabControl,
  type TabControl,
  type Timer,
} from "./RunnerBrowserControl.ts";
import {
  injectRecorder,
  markStep,
  nodeBox,
  readReport,
  recordCanvas,
  recorderKey,
} from "./RunnerBrowserRecorder.ts";
import type { BrowserRoute } from "./RunnerBrowserRoute.ts";
import { makeSegment, type Segment } from "./RunnerBrowserSegment.ts";

/**
 * The agent's browser as people watch it (#587). Each tab records itself
 * (`RunnerBrowserRecorder.ts`) into a segment that starts at its last step
 * (`RunnerBrowserSegment.ts`): a new viewer catches up from it, and the
 * agent's next finished action makes it a trail step. Watching never touches
 * the browser, so it never opens or keeps the person's browser connected: a
 * resting tab shows its last state. A tab records its canvases only while
 * someone watches it: they repaint as images, which nobody needs unseen.
 *
 * A viewer can take over the tab it watches (`RunnerBrowserControl.ts`); its
 * view stays on that tab until it hands it back, and the stretch it drove is
 * a trail step of its own (`person`).
 *
 * The agent can also hand a tab to the person (`handOff`, #579). Viewers
 * that follow the agent show that tab, with the handoff in their state.
 * While a person holds or drives a tab, all of the agent's actions on it
 * wait, reads included: nothing from the person's stretch reaches the agent.
 */

/** A tab as the mirror sees the browser: open, or the person's tab while its browser rests. */
export interface MirrorTab {
  readonly tabId: string;
  readonly route: BrowserRoute;
  /** Null while it rests. */
  readonly page: Page | null;
}

/** What the mirror reads from the browser it records. */
export interface MirrorHost {
  readonly tabs: () => ReadonlyArray<MirrorTab>;
  /** The tab the agent works in, resting or not. */
  readonly current: () => string | null;
  /** Why the person's browser can't open, in its provider's words. */
  readonly problem: () => string | null;
  /** Opens `tabId` for a person to drive, reconnecting a resting tab. */
  readonly drive: (tabId: string) => Promise<DrivenTab>;
}

/** What the browser tells the mirror about its tabs and the agent's actions. */
export interface MirrorRecorder {
  /** Records `page` as `tabId`, replacing the page the tab had. */
  readonly attach: (tabId: string, page: Page, cdp: CDPSession) => Promise<void>;
  /** The tabs, the current tab or the person's browser may have changed. */
  readonly changed: () => void;
  /**
   * Waits while a person drives or holds `tabId` (`AGENT_WAIT_MS` at most),
   * then marks the agent's action on it running until the returned `done`.
   */
  readonly agentTurn: (tabId: string) => Promise<() => void>;
  /**
   * An action on `tabId` finished; one in `AGENT_BROWSER_STEP_ACTIONS` ends a
   * trail step, and the others (hover, scroll, ...) ride with the next one.
   */
  readonly step: (
    tabId: string,
    action: string,
    startedAt: string,
    options: { readonly canMark: boolean },
  ) => void;
  /** Who drives `tabId`, as `preview_status` reports it: a human while the agent waits on it. */
  readonly control: (tabId: string | null) => {
    readonly owner: "agent" | "human";
    readonly generation: number;
  };
  /** Hands `tabId` to the person, or back to the agent with null. */
  readonly handOff: (tabId: string, handoff: AgentBrowserHandoff | null) => void;
  readonly close: () => void;
}

/** One viewer's mirror. */
export interface MirrorViewer {
  readonly input: (input: AgentBrowserInput) => void;
  /** The viewer left: hands its tab back, if it held one. */
  readonly close: () => void;
}

/** The viewers' side of the mirror, which the tunnel serves. */
export interface BrowserMirror {
  /**
   * A viewer of `tabId`, or of the agent's current tab when null, until it
   * closes or `end`. `send` gets each `AgentBrowserUpdate` as one NDJSON line;
   * viewers of a tab share its events' bytes, so treat them as read-only.
   */
  readonly watch: (input: {
    readonly viewerId: string;
    readonly tabId: string | null;
    readonly send: (line: Uint8Array) => void;
    readonly end: () => void;
  }) => MirrorViewer;
  /** Every finished step with its rrweb events (a JSON array), until the returned unsubscribe. */
  readonly onStep: (listener: (step: AgentBrowserStep, events: string) => void) => () => void;
}

const STEP_ACTIONS: ReadonlySet<string> = new Set(AGENT_BROWSER_STEP_ACTIONS);
const MARK_TIMEOUT_MS = 5_000;

const encoder = new TextEncoder();
const lineOf = (update: AgentBrowserUpdate) => encoder.encode(`${JSON.stringify(update)}\n`);

interface Viewer {
  readonly viewerId: string;
  readonly follow: string | null;
  readonly send: (line: Uint8Array) => void;
  readonly end: () => void;
  shown: string | null;
  held: string | null;
  sentState: string;
  notice: string | null;
}

interface Hub {
  readonly tabId: string;
  /** What the tab's recorder is called in its pages. */
  readonly key: string;
  page: Page | null;
  readonly segment: Segment;
  url: string;
  title: string;
  /** Steps whose mark the page hasn't sent back yet, oldest first. */
  readonly marks: Map<string, { readonly action: string; readonly startedAt: string }>;
  readonly control: TabControl<Viewer>;
  /** Someone watches the tab, so its page records canvases. */
  watched: boolean;
  handoff: AgentBrowserHandoff | null;
}

export const makeBrowserMirror = (
  host: MirrorHost,
  options: { readonly timer?: Timer } = {},
): { readonly recorder: MirrorRecorder; readonly mirror: BrowserMirror } => {
  const timer = options.timer ?? defaultTimer;
  const hubs = new Map<string, Hub>();
  const viewers = new Set<Viewer>();
  const stepListeners = new Set<(step: AgentBrowserStep, events: string) => void>();

  const hubFor = (tabId: string): Hub => {
    const existing = hubs.get(tabId);
    if (existing !== undefined) return existing;
    const key = recorderKey();
    const hub: Hub = {
      tabId,
      key,
      page: null,
      segment: makeSegment(),
      url: "",
      title: "",
      marks: new Map(),
      control: makeTabControl<Viewer>({
        open: () => host.drive(tabId),
        timer,
        changed: (handedBack) => {
          if (handedBack !== null) {
            if (handedBack.viewer.held === tabId) handedBack.viewer.held = null;
            if (handedBack.notice !== null) handedBack.viewer.notice = handedBack.notice;
          }
          refresh();
        },
        settle: (takenAt, cdp) => endStep(hub, "person", takenAt, cdp !== null),
        locate: (cdp, node) => nodeBox(cdp, key, node),
      }),
      watched: false,
      handoff: null,
    };
    hubs.set(tabId, hub);
    return hub;
  };

  const tabOf = (info: MirrorTab): AgentBrowserTab => {
    const hub = hubs.get(info.tabId);
    return {
      tabId: info.tabId,
      url: info.page?.url() ?? hub?.url ?? "",
      title: hub?.title ?? "",
      browser: info.route,
    };
  };

  /** Has each tab record canvases exactly while someone watches it. */
  const watchCanvases = () => {
    const shown = new Set<string | null>();
    for (const viewer of viewers) shown.add(viewer.shown);
    for (const hub of hubs.values()) {
      const watched = shown.has(hub.tabId);
      if (watched === hub.watched) continue;
      hub.watched = watched;
      if (hub.page !== null) void recordCanvas(hub.page, hub.key, watched);
    }
  };

  /** Sends each viewer its state when it changed, and the page when it shows another tab. */
  function refresh() {
    const tabs = host.tabs();
    const gone = [...hubs.values()].filter((hub) => !tabs.some((tab) => tab.tabId === hub.tabId));
    for (const hub of gone) hubs.delete(hub.tabId);
    for (const hub of gone) hub.control.handBack("The tab closed.");
    if (viewers.size === 0) return watchCanvases();
    // A tab handed to the person is what everyone following the agent needs to see.
    const current = [...hubs.values()].find((hub) => hub.handoff !== null)?.tabId ?? host.current();
    const problem = host.problem();
    const listed = tabs.map(tabOf);
    /** Each tab's catch-up line, built once for every viewer switching to it. */
    const catchUps = new Map<string, Uint8Array | null>();
    const catchUpOf = (hub: Hub) => {
      if (!catchUps.has(hub.tabId)) {
        const events = hub.segment.catchUp();
        catchUps.set(
          hub.tabId,
          events === null ? null : lineOf({ _tag: "events", tabId: hub.tabId, events }),
        );
      }
      return catchUps.get(hub.tabId) ?? null;
    };
    for (const viewer of viewers) {
      const wanted = viewer.held ?? viewer.follow ?? current;
      const shown = tabs.find((tab) => tab.tabId === wanted);
      const switched = (shown?.tabId ?? null) !== viewer.shown;
      viewer.shown = shown?.tabId ?? null;
      const hub = viewer.shown === null ? undefined : hubs.get(viewer.shown);
      const holder = hub?.control.holder() ?? null;
      const state = {
        _tag: "state" as const,
        viewerId: viewer.viewerId,
        tabs: listed,
        tabId: viewer.shown,
        control:
          holder === null
            ? ("agent" as const)
            : holder === viewer
              ? ("you" as const)
              : ("someone-else" as const),
        resting: shown !== undefined && shown.page === null,
        problem,
        handoff: hub?.handoff ?? null,
      };
      const key = JSON.stringify(state);
      if (key !== viewer.sentState || viewer.notice !== null) {
        viewer.send(lineOf({ ...state, notice: viewer.notice }));
        viewer.sentState = key;
        viewer.notice = null;
      }
      const catchUp = switched && hub !== undefined ? catchUpOf(hub) : null;
      if (catchUp !== null) viewer.send(catchUp);
    }
    watchCanvases();
  }

  const closeStep = (hub: Hub, stepId: string, marked: boolean) => {
    const start = hub.marks.get(stepId);
    if (start === undefined) return;
    // Steps marked before this one whose mark never came back end here too.
    for (const id of hub.marks.keys()) {
      hub.marks.delete(id);
      if (id === stepId) break;
    }
    const events = hub.segment.cut(marked);
    if (events === null) return;
    const step: AgentBrowserStep = {
      stepId,
      tabId: hub.tabId,
      action: start.action,
      url: hub.page?.url() ?? hub.url,
      title: hub.title,
      startedAt: start.startedAt,
      endedAt: new Date().toISOString(),
    };
    for (const listener of stepListeners) listener(step, events);
  };

  const ingest = (hub: Hub, page: Page, payload: string) => {
    if (hub.page !== page) return;
    const report = readReport(payload);
    if (report === null) return;
    if (report._tag === "step") return closeStep(hub, report.stepId, true);
    hub.segment.push(report.full, report.events);
    const retitled = report.title !== hub.title || report.url !== hub.url;
    hub.url = report.url;
    hub.title = report.title;
    // A new document records as the page's script starts it: without canvases.
    if (report.full && report.canvas !== hub.watched) void recordCanvas(page, hub.key, hub.watched);
    let line: Uint8Array | undefined;
    for (const viewer of viewers)
      if (viewer.shown === hub.tabId)
        viewer.send((line ??= lineOf({ _tag: "events", tabId: hub.tabId, events: report.events })));
    if (retitled) refresh();
  };

  /** Ends `hub`'s current step as `action`, once the page marked it or couldn't. */
  const endStep = (hub: Hub, action: string, startedAt: string, canMark: boolean) => {
    const stepId = `step-${NodeCrypto.randomUUID()}`;
    hub.marks.set(stepId, { action, startedAt });
    const page = hub.page;
    if (page === null || !canMark) {
      closeStep(hub, stepId, false);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const unmarked = () => {
        closeStep(hub, stepId, false);
        resolve();
      };
      // A page that never answers (e.g. one stuck in a long task) ends the step unmarked.
      const cancel = timer(unmarked, MARK_TIMEOUT_MS);
      markStep(page, hub.key, stepId).then(
        (marked) => {
          cancel();
          if (marked) resolve();
          else unmarked();
        },
        () => {
          cancel();
          unmarked();
        },
      );
    });
  };

  const take = (viewer: Viewer) => {
    if (viewer.shown === null) {
      viewer.notice = "There's no tab to take over.";
      return refresh();
    }
    const hub = hubFor(viewer.shown);
    if (viewer.held !== null && viewer.held !== hub.tabId)
      hubs.get(viewer.held)?.control.handBack(null);
    viewer.held = hub.tabId;
    if (hub.control.take(viewer)) return;
    viewer.held = null;
    viewer.notice = "Someone else is driving this tab.";
    refresh();
  };

  const heldBy = (viewer: Viewer) => {
    const hub = viewer.held === null ? undefined : hubs.get(viewer.held);
    return hub?.control.holder() === viewer ? hub : undefined;
  };

  const recorder: MirrorRecorder = {
    attach: async (tabId, page, cdp) => {
      const hub = hubFor(tabId);
      hub.page = page;
      await injectRecorder(page, cdp, hub.key, (payload) => ingest(hub, page, payload)).catch(
        constVoid,
      );
    },
    changed: refresh,
    agentTurn: (tabId) => {
      const hub = hubs.get(tabId);
      return hub === undefined ? Promise.resolve(constVoid) : hub.control.agentTurn();
    },
    step: (tabId, action, startedAt, { canMark }) => {
      const hub = hubs.get(tabId);
      if (hub !== undefined && STEP_ACTIONS.has(action))
        void endStep(hub, action, startedAt, canMark);
    },
    control: (tabId) => {
      const hub = tabId === null ? undefined : hubs.get(tabId);
      return {
        owner: hub?.control.personal() === true ? "human" : "agent",
        generation: hub?.control.generation() ?? 0,
      };
    },
    handOff: (tabId, handoff) => {
      // A tab that closed has nothing to give back.
      const hub = handoff === null ? hubs.get(tabId) : hubFor(tabId);
      if (hub === undefined) return;
      hub.handoff = handoff;
      if (!hub.control.hold(handoff !== null)) refresh();
    },
    close: () => {
      for (const hub of hubs.values()) hub.control.handBack(null);
      for (const viewer of viewers) viewer.end();
      viewers.clear();
    },
  };

  const mirror: BrowserMirror = {
    watch: (input) => {
      const viewer: Viewer = {
        viewerId: input.viewerId,
        follow: input.tabId,
        send: input.send,
        end: input.end,
        shown: null,
        held: null,
        sentState: "",
        notice: null,
      };
      viewers.add(viewer);
      refresh();
      return {
        input: (message) => {
          if (!viewers.has(viewer)) return;
          if (message._tag === "take") return take(viewer);
          if (message._tag === "release") return heldBy(viewer)?.control.handBack(null);
          heldBy(viewer)?.control.drive(viewer, message);
        },
        close: () => {
          if (!viewers.delete(viewer)) return;
          heldBy(viewer)?.control.handBack(null);
          watchCanvases();
        },
      };
    },
    onStep: (listener) => {
      stepListeners.add(listener);
      return () => void stepListeners.delete(listener);
    },
  };

  return { recorder, mirror };
};
