/**
 * A thread's browsing (#585). Part of `WsRpcGroup`.
 *
 * Signalbox syncs the browsing, not the browser (#343): the thread keeps the
 * record of its open tabs, which one is active, where each was read to, and
 * where it has been. Every member edits the same list: the person's devices
 * and the thread's agents. Each device loads the record into its own engine
 * with its own session, so nothing here ever holds a cookie, token or form
 * value. Per-device state (window layout, zoom, last seen) stays on the device.
 *
 * Modeled on Chrome's shared tab groups: one shared, editable tab list with
 * fractional order keys, last writer wins per field. Every tab has one owner,
 * a person or an agent, and only the owner drives it: navigates, positions or
 * closes it (#343). A person's own tabs load in their devices' engines; an
 * agent's tabs live in its cloud browser and never in a person's engine.
 * A tab is private to its owner until they share it, for now or a number of
 * days (#597). Copying a tab is opening your own at its address: nothing of
 * the owner's session comes with it. A tab's position is a text fragment
 * (what Chrome's Send Tab to Self carries) with a scroll ratio as the fallback.
 *
 * Changes are events in the thread's own browsing log, separate from its
 * conversation, so scrolling never reaches the turn stream or automations.
 * Only environments advertising `capabilities.threadBrowsing` serve these.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PREVIEW_URL_MAX_LENGTH, PreviewTabId } from "./preview.ts";

export const SIGNALBOX_BROWSING_WS_METHODS = {
  subscribe: "signalbox.browsing.subscribe",
  dispatch: "signalbox.browsing.dispatch",
} as const;

/** Seeing the tabs is reading the thread; changing them operates its browser. */
export const SIGNALBOX_BROWSING_REQUIRED_SCOPES = {
  [SIGNALBOX_BROWSING_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [SIGNALBOX_BROWSING_WS_METHODS.dispatch]: AuthPreviewOperateScope,
} as const;

export const BROWSING_MAX_TABS = 100;
export const BROWSING_MAX_HISTORY = 100;

export const BROWSING_TITLE_MAX_LENGTH = 512;

const Url = TrimmedNonEmptyString.check(Schema.isMaxLength(PREVIEW_URL_MAX_LENGTH));
const Title = Schema.String.check(Schema.isMaxLength(BROWSING_TITLE_MAX_LENGTH));

/** A tab's id. The same id names the tab on every device and in the browser panel. */
export const BrowsingTabId = PreviewTabId;
export type BrowsingTabId = typeof BrowsingTabId.Type;

/**
 * One signed-in client. The environment derives it from the connection's
 * session, so a device can't speak for another; it is not a credential.
 */
export const BrowsingDeviceId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type BrowsingDeviceId = typeof BrowsingDeviceId.Type;

/**
 * Who changed the record: one of a person's devices, or an agent working in
 * the thread (its own browser, #574). A device skips reapplying its own changes.
 */
export const BrowsingMember = Schema.Union([
  Schema.TaggedStruct("Device", { userId: Schema.String, deviceId: BrowsingDeviceId }),
  Schema.TaggedStruct("Agent", { agentId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)) }),
]);
export type BrowsingMember = typeof BrowsingMember.Type;

/**
 * Who a tab belongs to: a person, on whichever of their devices, or an agent.
 * Only the owner drives the tab; anyone in the thread may switch to it or
 * reorder it.
 */
export const BrowsingOwner = Schema.Union([
  Schema.TaggedStruct("Person", { userId: Schema.String }),
  Schema.TaggedStruct("Agent", { agentId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)) }),
]);
export type BrowsingOwner = typeof BrowsingOwner.Type;

/**
 * Where a tab was read to, portable across engines and page sizes.
 * `textFragment` is a text directive as in `#:~:text=` (percent-encoded
 * start, optionally `,end`); `scrollRatio` is the fallback when the text is
 * gone. `mediaSeconds` is a playing video's time.
 */
export const BrowsingPosition = Schema.Struct({
  textFragment: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
  scrollRatio: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  mediaSeconds: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type BrowsingPosition = typeof BrowsingPosition.Type;

export const BROWSING_SHARE_MAX_DAYS = 30;

/**
 * Who besides its owner may see a shared tab: everyone who can see the
 * thread. Who "the team" is joins it once #640 decides.
 */
export const BrowsingShareAudience = Schema.Literal("Thread");
export type BrowsingShareAudience = typeof BrowsingShareAudience.Type;

/**
 * A tab its owner shared. Without it a tab is private: nobody else learns it
 * exists. Sharing ends at `until` on its own, or whenever the owner stops it.
 */
export const BrowsingSharing = Schema.Struct({
  audience: BrowsingShareAudience,
  /** Null: until the owner stops sharing. */
  until: Schema.NullOr(Schema.String),
  since: Schema.String,
  /** Who shared it: the owner, from one of their devices or as the agent. */
  by: BrowsingMember,
});
export type BrowsingSharing = typeof BrowsingSharing.Type;

export const BrowsingTab = Schema.Struct({
  id: BrowsingTabId,
  /** Null for a new tab nobody has navigated yet. */
  url: Schema.NullOr(Url),
  title: Title,
  /** Fractional index: tabs sort by it as plain strings. */
  orderKey: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  owner: BrowsingOwner,
  position: Schema.optional(BrowsingPosition),
  /** Who last moved `position`, so a device doesn't restore what it reported itself. */
  positionBy: Schema.optional(BrowsingMember),
  sharing: Schema.optional(BrowsingSharing),
  updatedAt: Schema.String,
});
export type BrowsingTab = typeof BrowsingTab.Type;

/** Where the thread's tabs have been, newest first. URL and title only. */
export const BrowsingHistoryEntry = Schema.Struct({
  url: Url,
  title: Title,
  at: Schema.String,
});
export type BrowsingHistoryEntry = typeof BrowsingHistoryEntry.Type;

/** A thread's browsing as of `sequence`. `tabs` are in order. */
export const BrowsingRecord = Schema.Struct({
  tabs: Schema.Array(BrowsingTab).check(Schema.isMaxLength(BROWSING_MAX_TABS)),
  activeTabId: Schema.NullOr(BrowsingTabId),
  history: Schema.Array(BrowsingHistoryEntry).check(Schema.isMaxLength(BROWSING_MAX_HISTORY)),
});
export type BrowsingRecord = typeof BrowsingRecord.Type;

export const EMPTY_BROWSING_RECORD: BrowsingRecord = { tabs: [], activeTabId: null, history: [] };

const eventBase = {
  sequence: PositiveInt,
  at: Schema.String,
  by: BrowsingMember,
};

/** One change to the record. Small on purpose: each one crosses the wire on its own. */
export const BrowsingEvent = Schema.Union([
  Schema.TaggedStruct("TabOpened", { ...eventBase, tab: BrowsingTab }),
  Schema.TaggedStruct("TabNavigated", {
    ...eventBase,
    tabId: BrowsingTabId,
    url: Url,
    title: Title,
  }),
  Schema.TaggedStruct("TabMoved", {
    ...eventBase,
    tabId: BrowsingTabId,
    orderKey: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  }),
  Schema.TaggedStruct("TabActivated", { ...eventBase, tabId: Schema.NullOr(BrowsingTabId) }),
  Schema.TaggedStruct("TabClosed", { ...eventBase, tabId: BrowsingTabId }),
  Schema.TaggedStruct("TabPositioned", {
    ...eventBase,
    tabId: BrowsingTabId,
    position: BrowsingPosition,
  }),
  Schema.TaggedStruct("TabShared", {
    ...eventBase,
    tabId: BrowsingTabId,
    sharing: BrowsingSharing,
  }),
  /** `Expired`: its `until` passed, and `by` is whoever shared it. */
  Schema.TaggedStruct("TabUnshared", {
    ...eventBase,
    tabId: BrowsingTabId,
    reason: Schema.Literals(["Stopped", "Expired"]),
  }),
]);
export type BrowsingEvent = typeof BrowsingEvent.Type;

/** A change a member asks for. The thread decides its events, order keys and times. */
export const BrowsingCommand = Schema.Union([
  /**
   * `tabId` is the client's, so a retried open lands once; an open of an
   * existing tab changes nothing. Without `afterTabId` the tab goes last.
   */
  Schema.TaggedStruct("Open", {
    tabId: BrowsingTabId,
    url: Schema.optional(Url),
    title: Schema.optional(Title),
    afterTabId: Schema.optional(BrowsingTabId),
    activate: Schema.Boolean,
  }),
  Schema.TaggedStruct("Navigate", { tabId: BrowsingTabId, url: Url, title: Title }),
  /** Puts the tab right before `beforeTabId`, or last for null. */
  Schema.TaggedStruct("Move", { tabId: BrowsingTabId, beforeTabId: Schema.NullOr(BrowsingTabId) }),
  Schema.TaggedStruct("Activate", { tabId: BrowsingTabId }),
  Schema.TaggedStruct("Close", { tabId: BrowsingTabId }),
  Schema.TaggedStruct("CloseAll", {}),
  Schema.TaggedStruct("Position", { tabId: BrowsingTabId, position: BrowsingPosition }),
  /**
   * Shares the tab for `days`, or until stopped for null. Sharing again
   * replaces the end. Only the owner shares.
   */
  Schema.TaggedStruct("Share", {
    tabId: BrowsingTabId,
    audience: BrowsingShareAudience,
    days: Schema.NullOr(PositiveInt.check(Schema.isLessThanOrEqualTo(BROWSING_SHARE_MAX_DAYS))),
  }),
  Schema.TaggedStruct("Unshare", { tabId: BrowsingTabId }),
]);
export type BrowsingCommand = typeof BrowsingCommand.Type;

/**
 * The record once, then every change after it. `you` is how the record names
 * this connection, so a device can tell its own changes from everyone else's.
 */
export const BrowsingStreamItem = Schema.Union([
  Schema.TaggedStruct("Snapshot", {
    sequence: NonNegativeInt,
    record: BrowsingRecord,
    you: BrowsingMember,
  }),
  Schema.TaggedStruct("Event", { event: BrowsingEvent }),
]);
export type BrowsingStreamItem = typeof BrowsingStreamItem.Type;

export const BrowsingDispatchInput = Schema.Struct({
  threadId: ThreadId,
  command: BrowsingCommand,
});
export type BrowsingDispatchInput = typeof BrowsingDispatchInput.Type;

/** The record's sequence after the command; unchanged when it changed nothing. */
export const BrowsingDispatchResult = Schema.Struct({ sequence: NonNegativeInt });
export type BrowsingDispatchResult = typeof BrowsingDispatchResult.Type;

export class SignalboxBrowsingUnavailableError extends Schema.TaggedError<SignalboxBrowsingUnavailableError>()(
  "SignalboxBrowsingUnavailableError",
  {},
) {
  override get message(): string {
    return "Synced browser tabs are only available in Signalbox Cloud.";
  }
}

/** The command can't apply: no such thread or tab, not the tab's owner, or the thread is at its tab limit. */
export class SignalboxBrowsingError extends Schema.TaggedError<SignalboxBrowsingError>()(
  "SignalboxBrowsingError",
  { message: Schema.String },
) {}

const BrowsingErrors = Schema.Union([
  SignalboxBrowsingUnavailableError,
  SignalboxBrowsingError,
  EnvironmentAuthorizationError,
]);

const SubscribeRpc = Rpc.make(SIGNALBOX_BROWSING_WS_METHODS.subscribe, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: BrowsingStreamItem,
  error: BrowsingErrors,
  stream: true,
});

const DispatchRpc = Rpc.make(SIGNALBOX_BROWSING_WS_METHODS.dispatch, {
  payload: BrowsingDispatchInput,
  success: BrowsingDispatchResult,
  error: BrowsingErrors,
});

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_BROWSING_RPCS = [SubscribeRpc, DispatchRpc] as const;
