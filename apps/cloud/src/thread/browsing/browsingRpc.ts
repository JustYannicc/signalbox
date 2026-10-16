import {
  BROWSING_PREVIEW_EPOCH,
  browsingTabSnapshot,
  isOwnedBy,
} from "@t3tools/client-runtime/browsing";
import {
  type PreviewListResult,
  type PreviewSessionSnapshot,
  PreviewInvalidUrlError,
  PreviewSessionLookupError,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  type BrowsingCommand,
  type BrowsingMember,
  type BrowsingRecord,
  EMPTY_BROWSING_RECORD,
  SIGNALBOX_BROWSING_WS_METHODS,
  SignalboxBrowsingError,
} from "@t3tools/contracts/signalboxBrowsing";
import { isPreviewUrlNormalizationError, normalizePreviewUrl } from "@t3tools/shared/preview";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Stream from "effect/Stream";

import { hashSecret, publicIdOf } from "../../auth/hashedSecrets.ts";
import * as CloudThreadService from "../CloudThreadService.ts";
import type { Actor } from "../ThreadEngine.ts";

/**
 * A connection's browsing RPCs (#585): the synced record itself, and the
 * browser panel's own `preview.*` RPCs served from it. The desktop panel
 * already opens, reports and closes tabs through `preview.*`; in the cloud
 * those calls change the thread's record, so every device sees the same tabs
 * while each loads them in its own engine. What only one engine can act on
 * (viewport, zoom, colour scheme, reload) stays on that device.
 */

/**
 * How the record names a connection: a short id from its session's hash, so
 * devices can tell each other apart without the session id, a credential,
 * ever leaving here.
 */
export const deviceMember = (userId: string, sid: string) =>
  Effect.flatMap(Crypto.Crypto, (crypto) =>
    Effect.map(hashSecret(crypto, `browsing\n${sid}`), (hash): BrowsingMember => ({
      _tag: "Device",
      userId,
      deviceId: publicIdOf(hash),
    })),
  );

/** The panel's sessions: only the tabs this device's person drives, never an agent's (#343). */
const previewList = (
  threadId: ThreadId,
  head: { readonly sequence: number; readonly record: BrowsingRecord },
  you: BrowsingMember,
): PreviewListResult => ({
  sessions: head.record.tabs
    .filter((tab) => isOwnedBy(tab, you))
    .map((tab) => browsingTabSnapshot(threadId, tab)),
  serverEpoch: BROWSING_PREVIEW_EPOCH,
  revision: head.sequence,
});

/** What the address bar typed, as a URL, the way a self-hosted server reads it (`preview/Manager.ts`). */
const normalizeUrl = (rawUrl: string) =>
  Effect.try({
    try: () => normalizePreviewUrl(rawUrl),
    catch: (cause) =>
      isPreviewUrlNormalizationError(cause)
        ? new PreviewInvalidUrlError({
            inputLength: cause.inputLength,
            reason: cause.reason,
            protocol: cause.protocol,
            cause,
          })
        : new PreviewInvalidUrlError({ inputLength: rawUrl.length, reason: "unexpected", cause }),
  });

export const makeBrowsingHandlers = Effect.fn("makeBrowsingHandlers")(function* (input: {
  readonly actorNow: Effect.Effect<Actor>;
  readonly you: BrowsingMember;
}) {
  const threads = yield* CloudThreadService.CloudThreadService;
  const crypto = yield* Crypto.Crypto;
  const { actorNow, you } = input;

  const logUnavailable = (error: CloudThreadService.CloudThreadError) =>
    error._tag === "ThreadObjectError"
      ? Effect.logError("cloud browsing call failed", { cause: error })
      : Effect.void;
  const message = (error: CloudThreadService.CloudThreadError) => {
    switch (error._tag) {
      case "ThreadNotFoundError":
        return "Thread not found.";
      case "ThreadCommandRejectedError":
        return error.reason;
      case "ThreadObjectError":
        return "The thread is unavailable right now. Try again.";
    }
  };

  const browse = (threadId: ThreadId, command: BrowsingCommand) =>
    Effect.flatMap(actorNow, (actor) => threads.browse(actor, threadId, you, command)).pipe(
      Effect.tapError(logUnavailable),
    );
  const head = (threadId: ThreadId) =>
    Effect.flatMap(actorNow, (actor) => threads.browsingRecord(actor, threadId)).pipe(
      Effect.tapError(logUnavailable),
    );
  /**
   * A `preview.*` change as the panel sees it: the tab after the command, with
   * what only this device set (`local`) on top. The panel only knows sessions
   * that exist or don't, so every failure is a lookup failure.
   */
  const changeTab = (
    threadId: ThreadId,
    tabId: string,
    command: BrowsingCommand,
    local: Partial<PreviewSessionSnapshot> = {},
  ) =>
    browse(threadId, command).pipe(
      Effect.mapError(() => new PreviewSessionLookupError({ threadId, tabId })),
      Effect.flatMap(({ tab }) =>
        tab === null
          ? Effect.fail(new PreviewSessionLookupError({ threadId, tabId }))
          : Effect.succeed({ ...browsingTabSnapshot(threadId, tab), ...local }),
      ),
    );
  /** The tab now, for the calls only this device acts on. */
  const currentTab = (
    threadId: ThreadId,
    tabId: string,
    local: Partial<PreviewSessionSnapshot> = {},
  ) =>
    head(threadId).pipe(
      Effect.mapError(() => new PreviewSessionLookupError({ threadId, tabId })),
      Effect.flatMap(({ record }) => {
        const tab = record.tabs.find((candidate) => candidate.id === tabId);
        return tab === undefined
          ? Effect.fail(new PreviewSessionLookupError({ threadId, tabId }))
          : Effect.succeed({ ...browsingTabSnapshot(threadId, tab), ...local });
      }),
    );

  return {
    [SIGNALBOX_BROWSING_WS_METHODS.subscribe]: ({ threadId }: { readonly threadId: ThreadId }) =>
      Stream.unwrap(Effect.map(actorNow, (actor) => threads.browsing(actor, threadId, you))).pipe(
        Stream.flatMap((batch) => Stream.fromIterable(batch)),
        Stream.tapError(logUnavailable),
        Stream.mapError((error) => new SignalboxBrowsingError({ message: message(error) })),
      ),
    [SIGNALBOX_BROWSING_WS_METHODS.dispatch]: (request: {
      readonly threadId: ThreadId;
      readonly command: BrowsingCommand;
    }) =>
      browse(request.threadId, request.command).pipe(
        Effect.map(({ sequence }) => ({ sequence })),
        Effect.mapError((error) => new SignalboxBrowsingError({ message: message(error) })),
      ),

    [WS_METHODS.previewOpen]: (request: {
      readonly threadId: ThreadId;
      readonly url?: string | undefined;
      readonly viewport?: PreviewSessionSnapshot["viewport"];
      readonly profileId?: PreviewSessionSnapshot["profileId"];
      /** False for a tab opened in the background (cmd-click): nobody switches to it. */
      readonly reveal?: boolean | undefined;
    }) =>
      Effect.gen(function* () {
        const url = request.url === undefined ? undefined : yield* normalizeUrl(request.url);
        const tabId = `tab_${Hex.encode(yield* Effect.orDie(crypto.randomBytes(12)))}`;
        return yield* changeTab(
          request.threadId,
          tabId,
          {
            _tag: "Open",
            tabId,
            ...(url === undefined ? {} : { url }),
            activate: request.reveal !== false,
          },
          {
            ...(request.viewport === undefined ? {} : { viewport: request.viewport }),
            ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
          },
        );
      }),
    [WS_METHODS.previewNavigate]: (request: {
      readonly threadId: ThreadId;
      readonly tabId: string;
      readonly url: string;
      readonly resolvedTitle?: string | undefined;
    }) =>
      // The new page's title arrives with its load report; the old one would be wrong meanwhile.
      Effect.flatMap(normalizeUrl(request.url), (url) =>
        changeTab(request.threadId, request.tabId, {
          _tag: "Navigate",
          tabId: request.tabId,
          url,
          title: request.resolvedTitle ?? "",
        }),
      ),
    [WS_METHODS.previewReportStatus]: (request: {
      readonly threadId: ThreadId;
      readonly tabId: string;
      readonly navStatus: PreviewSessionSnapshot["navStatus"];
    }) => {
      const status = request.navStatus;
      // Loading reports come before the title; the finished load says where the tab is.
      if (status._tag !== "Success" && status._tag !== "LoadFailed") return Effect.void;
      return browse(request.threadId, {
        _tag: "Navigate",
        tabId: request.tabId,
        url: status.url,
        title: status.title,
      }).pipe(
        Effect.asVoid,
        Effect.mapError(
          () => new PreviewSessionLookupError({ threadId: request.threadId, tabId: request.tabId }),
        ),
      );
    },
    [WS_METHODS.previewClose]: (request: {
      readonly threadId: ThreadId;
      readonly tabId?: string | undefined;
    }) =>
      browse(
        request.threadId,
        request.tabId === undefined
          ? { _tag: "CloseAll" }
          : { _tag: "Close", tabId: request.tabId },
      ).pipe(
        Effect.asVoid,
        Effect.mapError(
          () =>
            new PreviewSessionLookupError({
              threadId: request.threadId,
              tabId: request.tabId ?? "",
            }),
        ),
      ),
    [WS_METHODS.previewList]: ({ threadId }: { readonly threadId: ThreadId }) =>
      head(threadId).pipe(
        Effect.map((current) => previewList(threadId, current, you)),
        // The panel lists nothing for a thread it can't see, as a self-hosted server would.
        Effect.orElseSucceed(() =>
          previewList(threadId, { sequence: 0, record: EMPTY_BROWSING_RECORD }, you),
        ),
      ),
    // Each device's own engine: its size, zoom, colours and reloads aren't the thread's.
    [WS_METHODS.previewResize]: (request: {
      readonly threadId: ThreadId;
      readonly tabId: string;
      readonly viewport: NonNullable<PreviewSessionSnapshot["viewport"]>;
    }) => currentTab(request.threadId, request.tabId, { viewport: request.viewport }),
    [WS_METHODS.previewAdjust]: (request: {
      readonly threadId: ThreadId;
      readonly tabId: string;
      readonly colorScheme?: PreviewSessionSnapshot["colorScheme"];
      readonly zoomFactor?: PreviewSessionSnapshot["zoomFactor"];
    }) =>
      currentTab(request.threadId, request.tabId, {
        ...(request.colorScheme === undefined ? {} : { colorScheme: request.colorScheme }),
        ...(request.zoomFactor === undefined ? {} : { zoomFactor: request.zoomFactor }),
      }),
    // The device reloads its own engine; the thread has nothing to do.
    [WS_METHODS.previewRefresh]: () => Effect.void,
    // Profiles are each desktop's own Chromium partitions; the cloud keeps none.
    [WS_METHODS.previewReportProfiles]: () => Effect.void,
    [WS_METHODS.previewClearProfile]: () => Effect.void,
    // Tab changes reach panels through each thread's browsing stream, not this global feed.
    [WS_METHODS.subscribePreviewEvents]: () => Stream.never,
  };
});
