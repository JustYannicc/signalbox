/**
 * Signalbox previews. Part of `WsRpcGroup`.
 *
 * Thread files and dev servers open at their own HTTPS origins through the
 * PreviewGateway, for thread members only. A preview link belongs to the
 * thread, across execution placements. Opening a declared dev server starts
 * it when needed; an open server preview keeps its execution alive.
 *
 * Only environments advertising `capabilities.signalboxPreviews` serve these.
 * A self-hosted server answers `SignalboxPreviewsUnavailableError`; its own
 * previews go through the browser panel instead.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { PositiveInt, ThreadId } from "./baseSchemas.ts";

export const SIGNALBOX_PREVIEWS_WS_METHODS = {
  subscribe: "signalbox.previews.subscribe",
  open: "signalbox.previews.open",
} as const;

/** A routing slot for the thread's files, stable across execution placements. */
export const THREAD_FILES_PREVIEW_PORT = 80;

/** The agent's browser (see `AgentBrowserTab`). */
export const SIGNALBOX_AGENT_BROWSER_WS_METHODS = {
  watch: "signalbox.previews.browserWatch",
  input: "signalbox.previews.browserInput",
  trail: "signalbox.previews.browserTrail",
  step: "signalbox.previews.browserStep",
} as const;

/** Seeing what runs is reading the thread; using it can change the app under preview. */
export const SIGNALBOX_PREVIEWS_REQUIRED_SCOPES = {
  [SIGNALBOX_PREVIEWS_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [SIGNALBOX_PREVIEWS_WS_METHODS.open]: AuthOrchestrationOperateScope,
  // Watching the agent's browser reads the thread; taking over acts in the person's browser.
  [SIGNALBOX_AGENT_BROWSER_WS_METHODS.watch]: AuthOrchestrationReadScope,
  [SIGNALBOX_AGENT_BROWSER_WS_METHODS.input]: AuthOrchestrationOperateScope,
  [SIGNALBOX_AGENT_BROWSER_WS_METHODS.trail]: AuthOrchestrationReadScope,
  [SIGNALBOX_AGENT_BROWSER_WS_METHODS.step]: AuthOrchestrationReadScope,
} as const;

/** A declared dev server or a web server listening on the thread's machine. */
export const SignalboxPreviewPort = Schema.Struct({
  port: PositiveInt,
  /** The process listening, when the machine could tell. */
  processName: Schema.NullOr(Schema.String),
});
export type SignalboxPreviewPort = typeof SignalboxPreviewPort.Type;

/** Declared previews stay available while the machine is stopped. */
export const SignalboxThreadPreviews = Schema.Struct({
  threadId: ThreadId,
  ports: Schema.Array(SignalboxPreviewPort),
  /** The agent has browsed in this thread: its trail has steps (#587). */
  browsed: Schema.optionalKey(Schema.Boolean),
});
export type SignalboxThreadPreviews = typeof SignalboxThreadPreviews.Type;

export const SignalboxPreviewOpenInput = Schema.Struct({
  threadId: ThreadId,
  port: PositiveInt,
  path: Schema.optionalKey(Schema.String),
});
export type SignalboxPreviewOpenInput = typeof SignalboxPreviewOpenInput.Type;

export const SignalboxPreviewLink = Schema.Struct({
  /** A stable app URL. The browser signs in before opening the isolated preview. */
  url: Schema.String,
});
export type SignalboxPreviewLink = typeof SignalboxPreviewLink.Type;

export class SignalboxPreviewsUnavailableError extends Schema.TaggedError<SignalboxPreviewsUnavailableError>()(
  "SignalboxPreviewsUnavailableError",
  {},
) {
  override get message(): string {
    return "Previews are only available in Signalbox Cloud.";
  }
}

/** The preview cannot be opened: no access or no server declared on that port. */
export class SignalboxPreviewError extends Schema.TaggedError<SignalboxPreviewError>()(
  "SignalboxPreviewError",
  { message: Schema.String },
) {}

const PreviewErrors = Schema.Union([
  SignalboxPreviewsUnavailableError,
  SignalboxPreviewError,
  EnvironmentAuthorizationError,
]);

/** The thread's previews now and after every change. */
const SubscribeRpc = Rpc.make(SIGNALBOX_PREVIEWS_WS_METHODS.subscribe, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: SignalboxThreadPreviews,
  error: PreviewErrors,
  stream: true,
});

/** A fresh link to one of the thread's previews. */
const OpenRpc = Rpc.make(SIGNALBOX_PREVIEWS_WS_METHODS.open, {
  payload: SignalboxPreviewOpenInput,
  success: SignalboxPreviewLink,
  error: PreviewErrors,
});

/**
 * The agent's browser (#587). Real sites open in the person's browser and
 * thread work opens through the preview gateway, without their profile.
 * The browser records each tab as DOM snapshots and mutations (rrweb);
 * clients replay the recording as a read-only copy of the page.
 *
 * Watching costs no browser time: the mirror only reads what the agent's own
 * connection already sees, and shows the last state while the person's
 * browser rests. A viewer can take over a tab and drive it with its own input
 * until it hands the tab back, goes idle, or stops watching; the agent waits
 * for the tab meanwhile. Each agent step leaves a recording in the thread's
 * browser trail, so the page stays watchable after the machine stops.
 */
export const AgentBrowserTab = Schema.Struct({
  tabId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  /** `machine` is accepted for older recordings. New local-work tabs use `preview`. */
  browser: Schema.Literals(["person", "preview", "machine"]),
});
export type AgentBrowserTab = typeof AgentBrowserTab.Type;

/** Who drives the mirrored tab: the agent, this viewer, or another viewer. */
export const AgentBrowserControl = Schema.Literals(["agent", "you", "someone-else"]);
export type AgentBrowserControl = typeof AgentBrowserControl.Type;

/**
 * The actions that end a trail step: the agent's `preview_*` actions that
 * change the page, and `person` for a stretch someone drove. Hovers and
 * scrolls ride along with the next step.
 */
export const AGENT_BROWSER_STEP_ACTIONS = [
  "navigate",
  "open",
  "click",
  "type",
  "press",
  "select",
  "drag",
  "upload",
  "dialog",
  "person",
] as const;
export type AgentBrowserStepAction = (typeof AGENT_BROWSER_STEP_ACTIONS)[number];

/** One finished step of the agent's browsing, or a stretch the person drove. */
export const AgentBrowserStep = Schema.Struct({
  stepId: Schema.String,
  tabId: Schema.String,
  /** An `AgentBrowserStepAction`; a string so a newer machine's actions still decode. */
  action: Schema.String,
  url: Schema.String,
  title: Schema.String,
  startedAt: Schema.String,
  endedAt: Schema.String,
});
export type AgentBrowserStep = typeof AgentBrowserStep.Type;

/**
 * A tab the agent handed to the person (#579): a payment, which only a
 * person finishes. The agent waits on the tab, reading nothing, until the
 * person answers the "Payment" automation's ask (`runId`) with how it went.
 */
export const AgentBrowserHandoff = Schema.Struct({
  kind: Schema.Literal("payment"),
  /** The site, as its host. */
  site: Schema.String,
  /** The automation run asking the person; null until it started. */
  runId: Schema.NullOr(Schema.String),
  /** The page, when it can be finished in the person's own browser too (an account's cart). */
  ownBrowserUrl: Schema.NullOr(Schema.String),
});
export type AgentBrowserHandoff = typeof AgentBrowserHandoff.Type;

/** What a watch stream carries. */
export const AgentBrowserUpdate = Schema.Union([
  /** First, then on every change. */
  Schema.TaggedStruct("state", {
    /** Names this stream in `browserInput`. */
    viewerId: Schema.String,
    tabs: Schema.Array(AgentBrowserTab),
    /** The tab mirrored now; null while the agent has none open. */
    tabId: Schema.NullOr(Schema.String),
    control: AgentBrowserControl,
    /** The person's browser is in standby: the mirror holds its last state, at no cost. */
    resting: Schema.Boolean,
    /** Why the agent's browser can't open or act, in its provider's own words. */
    problem: Schema.NullOr(Schema.String),
    /** Said once, e.g. why control went back to the agent. */
    notice: Schema.NullOr(Schema.String),
    /** The mirrored tab waits on the person; absent from machines that never hand tabs off. */
    handoff: Schema.optionalKey(Schema.NullOr(AgentBrowserHandoff)),
  }),
  /**
   * rrweb events for `tabId`, as a JSON array. A batch that starts with a
   * full snapshot replaces the page the viewer shows.
   */
  Schema.TaggedStruct("events", { tabId: Schema.String, events: Schema.String }),
  /** A step finished; it is in the trail now. */
  Schema.TaggedStruct("step", { step: AgentBrowserStep }),
  /** No machine runs the thread: the trail is all there is until one does. */
  Schema.TaggedStruct("offline", {}),
]);
export type AgentBrowserUpdate = typeof AgentBrowserUpdate.Type;

const Modifiers = Schema.Number;
const MouseButton = Schema.Literals(["none", "left", "middle", "right"]);

/**
 * The element a pointer is over in the mirror, and where inside it. The
 * mirror lays the page out with the viewer's fonts, so its coordinates can
 * miss the agent's page; the machine aims at this element's box there instead,
 * falling back to `x`/`y` when it has no such element.
 */
export const AgentBrowserPointerTarget = Schema.Struct({
  /** rrweb's id for the element, from the recording. */
  node: Schema.Number,
  /** Where the pointer is across the element's box, 0 at its left edge and 1 at its right. */
  fx: Schema.Number,
  /** The same, 0 at its top edge and 1 at its bottom. */
  fy: Schema.Number,
});
export type AgentBrowserPointerTarget = typeof AgentBrowserPointerTarget.Type;

/** Input that drives the page, while the viewer holds the tab. Coordinates are the page's CSS pixels. */
export const AgentBrowserDrivingInput = Schema.Union([
  Schema.TaggedStruct("mouse", {
    action: Schema.Literals(["move", "down", "up"]),
    x: Schema.Number,
    y: Schema.Number,
    target: Schema.optionalKey(AgentBrowserPointerTarget),
    button: MouseButton,
    /** Pressed buttons: left 1, right 2, middle 4. */
    buttons: Schema.Number,
    clickCount: Schema.Number,
    modifiers: Modifiers,
  }),
  Schema.TaggedStruct("wheel", {
    x: Schema.Number,
    y: Schema.Number,
    target: Schema.optionalKey(AgentBrowserPointerTarget),
    deltaX: Schema.Number,
    deltaY: Schema.Number,
    modifiers: Modifiers,
  }),
  Schema.TaggedStruct("key", {
    action: Schema.Literals(["down", "up"]),
    key: Schema.String,
    code: Schema.String,
    /** Windows virtual key code (DOM `keyCode`); Enter, Backspace and arrows need it. */
    keyCode: Schema.optionalKey(Schema.Number),
    /** Only for printable keys without Ctrl or Meta. */
    text: Schema.optionalKey(Schema.String),
    modifiers: Modifiers,
  }),
  Schema.TaggedStruct("text", { text: Schema.String }),
]);
export type AgentBrowserDrivingInput = typeof AgentBrowserDrivingInput.Type;

/** A viewer's input to the tab it watches: take it over, drive it, hand it back. */
export const AgentBrowserInput = Schema.Union([
  Schema.TaggedStruct("take", {}),
  Schema.TaggedStruct("release", {}),
  ...AgentBrowserDrivingInput.members,
]);
export type AgentBrowserInput = typeof AgentBrowserInput.Type;

export const AgentBrowserWatchInput = Schema.Struct({
  threadId: ThreadId,
  /** Null follows whichever tab the agent works in. */
  tabId: Schema.NullOr(Schema.String),
});
export type AgentBrowserWatchInput = typeof AgentBrowserWatchInput.Type;

export const AgentBrowserInputRequest = Schema.Struct({
  threadId: ThreadId,
  viewerId: Schema.String,
  input: AgentBrowserInput,
});
export type AgentBrowserInputRequest = typeof AgentBrowserInputRequest.Type;

export const AgentBrowserTrail = Schema.Struct({
  /** Oldest first. */
  steps: Schema.Array(AgentBrowserStep),
});
export type AgentBrowserTrail = typeof AgentBrowserTrail.Type;

export const AgentBrowserStepInput = Schema.Struct({ threadId: ThreadId, stepId: Schema.String });
export type AgentBrowserStepInput = typeof AgentBrowserStepInput.Type;

export const AgentBrowserStepRecording = Schema.Struct({
  /** rrweb events as a JSON array, starting with a full snapshot. */
  events: Schema.String,
});
export type AgentBrowserStepRecording = typeof AgentBrowserStepRecording.Type;

/** The agent's browser, mirrored live, while the subscriber watches. */
const BrowserWatchRpc = Rpc.make(SIGNALBOX_AGENT_BROWSER_WS_METHODS.watch, {
  payload: AgentBrowserWatchInput,
  success: AgentBrowserUpdate,
  error: PreviewErrors,
  stream: true,
});

/** Input from a watch stream's viewer: take over, drive, hand back. */
const BrowserInputRpc = Rpc.make(SIGNALBOX_AGENT_BROWSER_WS_METHODS.input, {
  payload: AgentBrowserInputRequest,
  error: PreviewErrors,
});

const BrowserTrailRpc = Rpc.make(SIGNALBOX_AGENT_BROWSER_WS_METHODS.trail, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: AgentBrowserTrail,
  error: PreviewErrors,
});

const BrowserStepRpc = Rpc.make(SIGNALBOX_AGENT_BROWSER_WS_METHODS.step, {
  payload: AgentBrowserStepInput,
  success: AgentBrowserStepRecording,
  error: PreviewErrors,
});

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_PREVIEWS_RPCS = [
  SubscribeRpc,
  OpenRpc,
  BrowserWatchRpc,
  BrowserInputRpc,
  BrowserTrailRpc,
  BrowserStepRpc,
] as const;
