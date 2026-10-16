import {
  SIGNALBOX_AGENT_BROWSER_WS_METHODS,
  SIGNALBOX_PREVIEWS_WS_METHODS,
  SignalboxPreviewsUnavailableError,
} from "@t3tools/contracts/signalboxPreviews";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Previews of a thread's machine, and its agent's browser, go through
 * Signalbox Cloud's PreviewGateway. A self-hosted server's previews use the
 * browser panel instead, and clients only ask an environment that advertises
 * `capabilities.signalboxPreviews`.
 */
export const signalboxPreviewsWsHandlers = {
  [SIGNALBOX_PREVIEWS_WS_METHODS.subscribe]: (_input: {}) =>
    Stream.fail(new SignalboxPreviewsUnavailableError()),
  [SIGNALBOX_PREVIEWS_WS_METHODS.open]: (_input: {}) =>
    Effect.fail(new SignalboxPreviewsUnavailableError()),
  [SIGNALBOX_AGENT_BROWSER_WS_METHODS.watch]: (_input: {}) =>
    Stream.fail(new SignalboxPreviewsUnavailableError()),
  [SIGNALBOX_AGENT_BROWSER_WS_METHODS.input]: (_input: {}) =>
    Effect.fail(new SignalboxPreviewsUnavailableError()),
  [SIGNALBOX_AGENT_BROWSER_WS_METHODS.trail]: (_input: {}) =>
    Effect.fail(new SignalboxPreviewsUnavailableError()),
  [SIGNALBOX_AGENT_BROWSER_WS_METHODS.step]: (_input: {}) =>
    Effect.fail(new SignalboxPreviewsUnavailableError()),
};
