// @effect-diagnostics globalDate:off - Formats a wire timestamp for display.
import type {
  AgentBrowserControl,
  AgentBrowserStepAction,
} from "@t3tools/contracts/signalboxPreviews";

import type { AgentBrowserSegment, AgentBrowserView } from "./signalboxAgentBrowser.ts";
import type { AgentBrowserMirrorHostMessage } from "./signalboxAgentBrowserMirror.ts";

/** What the mirror frame shows. */
export type AgentBrowserFrame =
  /** Keep the last frame: paused, reconnecting, or the page is on its way. */
  | { readonly kind: "hold" }
  | { readonly kind: "blank"; readonly reason: string }
  | { readonly kind: "live"; readonly segment: AgentBrowserSegment }
  | { readonly kind: "step"; readonly stepId: string };

export function agentBrowserFrame(input: {
  readonly view: AgentBrowserView | null;
  readonly selectedStepId: string | null;
  readonly lastStepId: string | null;
}): AgentBrowserFrame {
  const { view, selectedStepId, lastStepId } = input;
  if (selectedStepId !== null) return { kind: "step", stepId: selectedStepId };
  if (view === null) return { kind: "hold" };
  if (view.offline) {
    return lastStepId === null
      ? { kind: "blank", reason: "The agent hasn't browsed in this thread yet" }
      : { kind: "step", stepId: lastStepId };
  }
  if (view.tabId === null) return { kind: "blank", reason: "The agent has no page open" };
  return view.segment === null ? { kind: "hold" } : { kind: "live", segment: view.segment };
}

/** The status line: who drives, and what else is true right now. */
export function agentBrowserStatus(input: {
  readonly view: AgentBrowserView | null;
  readonly watching: boolean;
  readonly error: string | null;
  readonly hasSteps: boolean;
}): { readonly control: string | null; readonly detail: string | null } {
  const { view, watching, error, hasSteps } = input;
  if (!watching) return { control: null, detail: "Paused while you're away" };
  if (error !== null) return { control: null, detail: error };
  if (view === null) return { control: null, detail: "Connecting…" };
  if (view.offline) {
    return {
      control: null,
      detail: hasSteps ? "The machine is off · showing the last step" : "The machine is off",
    };
  }
  return {
    control: agentBrowserControlLabel(view.control),
    detail: view.notice ?? (view.resting ? "Resting · showing the last state" : null),
  };
}

/** What to put in the mirror. `hold` keeps whatever it shows now. */
export type AgentBrowserMirrorContent =
  | { readonly kind: "hold" }
  | { readonly kind: "blank" }
  | { readonly kind: "live"; readonly segment: AgentBrowserSegment }
  | { readonly kind: "recording"; readonly id: string; readonly events: string };

/** The frame as mirror content; a step holds until its `recording` has loaded. */
export function agentBrowserMirrorContent(
  frame: AgentBrowserFrame,
  recording: { readonly events: string } | null,
): AgentBrowserMirrorContent {
  switch (frame.kind) {
    case "hold":
      return { kind: "hold" };
    case "blank":
      return { kind: "blank" };
    case "live":
      return { kind: "live", segment: frame.segment };
    case "step":
      return recording === null
        ? { kind: "hold" }
        : { kind: "recording", id: frame.stepId, events: recording.events };
  }
}

/** What the page already has: which content, and how many of its batches. */
export interface AgentBrowserMirrorDelivered {
  readonly key: string | null;
  readonly count: number;
}

/** Nothing sent yet, also the state after the page (re)loads. */
export const AGENT_BROWSER_MIRROR_NOTHING_DELIVERED: AgentBrowserMirrorDelivered = {
  key: null,
  count: 0,
};

/**
 * The messages that bring the page from what it has to `content`: each live
 * batch goes out once, a recording replaces the page, `hold` sends nothing.
 */
export function planAgentBrowserMirrorDelivery(
  content: AgentBrowserMirrorContent,
  delivered: AgentBrowserMirrorDelivered,
): {
  readonly messages: ReadonlyArray<AgentBrowserMirrorHostMessage>;
  readonly delivered: AgentBrowserMirrorDelivered;
} {
  switch (content.kind) {
    case "hold":
      return { messages: [], delivered };
    case "blank":
      return delivered.key === "blank"
        ? { messages: [], delivered }
        : { messages: [{ type: "reset" }], delivered: { key: "blank", count: 0 } };
    case "recording": {
      const key = `recording:${content.id}`;
      if (delivered.key === key) return { messages: [], delivered };
      return {
        messages: [{ type: "reset" }, { type: "events", events: content.events }],
        delivered: { key, count: 1 },
      };
    }
    case "live": {
      const key = `live:${content.segment.id}`;
      // A new segment starts with a full snapshot, which replaces the page by itself.
      const from = delivered.key === key ? delivered.count : 0;
      const { batches, count } = content.segment;
      const messages: Array<AgentBrowserMirrorHostMessage> = [];
      for (let index = from; index < count; index += 1) {
        messages.push({ type: "events", events: batches[index]! });
      }
      return { messages, delivered: { key, count } };
    }
  }
}

const STEP_LABELS: Readonly<Record<AgentBrowserStepAction, string>> = {
  navigate: "Went to a page",
  open: "Opened a tab",
  click: "Clicked",
  type: "Typed",
  press: "Pressed a key",
  select: "Picked an option",
  drag: "Dragged",
  upload: "Uploaded a file",
  dialog: "Answered a dialog",
  person: "Taken over",
};

const isStepAction = (action: string): action is AgentBrowserStepAction =>
  Object.hasOwn(STEP_LABELS, action);

/** What a trail step did, in a few words; a newer machine's action reads as itself. */
export function agentBrowserStepLabel(action: string): string {
  if (isStepAction(action)) return STEP_LABELS[action];
  return action.length > 0 ? action[0]!.toUpperCase() + action.slice(1) : "Step";
}

/** A tab or step's place: its title, else its URL's host, else `fallback`. */
export function agentBrowserPlaceLabel(title: string, url: string, fallback: string): string {
  if (title.trim().length > 0) return title;
  try {
    return new URL(url).host || fallback;
  } catch {
    return fallback;
  }
}

const STEP_TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** When a step ended, as a clock time; empty if the timestamp doesn't parse. */
export function agentBrowserStepTime(endedAt: string): string {
  const at = new Date(endedAt);
  return Number.isNaN(at.getTime()) ? "" : STEP_TIME.format(at);
}

/** Who drives the tab, said the same way on every client. */
export function agentBrowserControlLabel(control: AgentBrowserControl): string {
  switch (control) {
    case "agent":
      return "The agent is driving";
    case "you":
      return "You're driving · the agent waits";
    case "someone-else":
      return "Someone else is driving";
  }
}
