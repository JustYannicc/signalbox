/**
 * Signalbox previews. Part of `WsRpcGroup`.
 *
 * A thread's machine runs the dev servers its agents start. Signalbox Cloud
 * lists the ones it finds on the machine and opens each at its own origin
 * through the PreviewGateway, for the thread's members only. A preview link
 * works while the machine that served it runs; the next machine (a new
 * generation) needs a new link. An open preview keeps the machine awake.
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

/** Seeing what runs is reading the thread; using it can change the app under preview. */
export const SIGNALBOX_PREVIEWS_REQUIRED_SCOPES = {
  [SIGNALBOX_PREVIEWS_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [SIGNALBOX_PREVIEWS_WS_METHODS.open]: AuthOrchestrationOperateScope,
} as const;

/** A web server listening on the thread's machine. */
export const SignalboxPreviewPort = Schema.Struct({
  port: PositiveInt,
  /** The process listening, when the machine could tell. */
  processName: Schema.NullOr(Schema.String),
});
export type SignalboxPreviewPort = typeof SignalboxPreviewPort.Type;

/** What the thread's machine serves right now. Empty while no machine runs. */
export const SignalboxThreadPreviews = Schema.Struct({
  threadId: ThreadId,
  ports: Schema.Array(SignalboxPreviewPort),
});
export type SignalboxThreadPreviews = typeof SignalboxThreadPreviews.Type;

export const SignalboxPreviewOpenInput = Schema.Struct({
  threadId: ThreadId,
  port: PositiveInt,
});
export type SignalboxPreviewOpenInput = typeof SignalboxPreviewOpenInput.Type;

export const SignalboxPreviewLink = Schema.Struct({
  /** Opens the preview in any browser, for a couple of minutes. */
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

/** The preview can't be opened now: no such thread, no machine, or nothing on that port. */
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

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_PREVIEWS_RPCS = [SubscribeRpc, OpenRpc] as const;
