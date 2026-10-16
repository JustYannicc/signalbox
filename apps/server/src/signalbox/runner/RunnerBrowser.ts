// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Owns Playwright resources outside the Effect runtime.
import * as NodeCrypto from "node:crypto";

import {
  INCOGNITO_BROWSER_PROFILE_ID,
  type PreviewAutomationActionEvent,
  type PreviewAutomationClickInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDialogInput,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationResizeInput,
  type PreviewAutomationResizeResult,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSelectResult,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewAutomationTabTargetInput,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import { constVoid } from "effect/Function";
import type { CDPSession, Dialog, Page } from "playwright-core";

import { ServerBrowserContexts } from "../../preview/ServerBrowserContexts.ts";
import * as ServerBrowserPage from "../../preview/ServerBrowserPage.ts";
import { type BrowserRoute, browserFor } from "./RunnerBrowserRoute.ts";

/**
 * The browser agents in a cloud thread use (#402, #574), served to the
 * harnesses as the same `preview_*` tools agents use locally
 * (`RunnerBrowserTools.ts`). It is two browsers behind one set of tabs, and
 * `browserFor` picks a tab's by the URL it opens, so the agent never names
 * one:
 *
 * - the machine's headless Chromium, for the thread's dev servers: throwaway
 *   storage and nobody's cookies;
 * - the person's browser (`RunnerBrowserPerson.ts`), for real sites, signed in
 *   with their profile.
 *
 * A tab whose next URL belongs to the other browser moves there under the same
 * tab id, so a dev tab never carries the profile and a real site never runs
 * in the cookie-less browser.
 */

type TabInput = PreviewAutomationTabTargetInput;

/** What the `preview_*` tools ask of a browser, in the contracts' own shapes. */
export interface BrowserBackend {
  readonly status: (input: TabInput) => Promise<PreviewAutomationStatus>;
  readonly open: (input: PreviewAutomationOpenInput) => Promise<PreviewAutomationStatus>;
  readonly navigate: (input: PreviewAutomationNavigateInput) => Promise<PreviewAutomationStatus>;
  readonly dialog: (input: PreviewAutomationDialogInput) => Promise<PreviewAutomationStatus>;
  readonly resize: (input: PreviewAutomationResizeInput) => Promise<PreviewAutomationResizeResult>;
  readonly setColorScheme: (
    input: PreviewAutomationSetColorSchemeInput,
  ) => Promise<PreviewAutomationSetColorSchemeResult>;
  readonly snapshot: (input: TabInput) => Promise<PreviewAutomationSnapshot>;
  readonly click: (input: PreviewAutomationClickInput) => Promise<void>;
  readonly type: (input: PreviewAutomationTypeInput) => Promise<void>;
  readonly hover: (input: PreviewAutomationHoverInput) => Promise<void>;
  readonly select: (input: PreviewAutomationSelectInput) => Promise<PreviewAutomationSelectResult>;
  readonly drag: (input: PreviewAutomationDragInput) => Promise<void>;
  readonly upload: (input: PreviewAutomationUploadInput) => Promise<void>;
  readonly press: (input: PreviewAutomationPressInput) => Promise<void>;
  readonly scroll: (input: PreviewAutomationScrollInput) => Promise<void>;
  readonly evaluate: (input: PreviewAutomationEvaluateInput) => Promise<unknown>;
  readonly waitFor: (input: PreviewAutomationWaitForInput) => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Where the Runner image puts the pinned headless shell (see `image/Dockerfile`). */
export const BROWSER_EXECUTABLE_ENV = "SIGNALBOX_BROWSER_EXECUTABLE";

/** Screenshots render at twice the CSS size, as on the server's browser. */
const RENDER_SCALE = 2;
const NAVIGATION_TIMEOUT_MS = 30_000;
const EVALUATE_TIMEOUT_MS = 15_000;
const ACTION_TIMELINE_LIMIT = 50;
/** Open tabs at most; opening another closes the oldest, so a long thread can't pile them up. */
const TAB_LIMIT = 8;

/** Where one route's tabs open. */
export interface TabSource {
  /** A new page, connecting first when the browser isn't open; null when this cloud has none. */
  readonly newPage: () => Promise<Page | null>;
  /** Pages open in this browser that no tab holds, such as those still open after a reconnect. */
  readonly openPages?: () => ReadonlyArray<Page>;
  /** Connects again without opening a page, so the tabs it kept come back; false without one. */
  readonly reopen?: () => Promise<boolean>;
  /** Marks a tab action until the returned release, so an idle browser can let go between them. */
  readonly use?: () => () => void;
  readonly close: () => Promise<void>;
}

interface Tab {
  readonly tabId: string;
  readonly route: BrowserRoute;
  readonly page: Page;
  readonly cdp: CDPSession;
  /** The page's CDP target in the person's browser, which survives reconnecting. */
  readonly targetId: string | null;
  readonly consoleEntries: Array<PreviewAutomationConsoleEntry>;
  readonly networkEntries: Array<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: Array<PreviewAutomationActionEvent>;
  dialog: Dialog | null;
}

const pushBounded = <A>(
  buffer: Array<A>,
  entry: A,
  limit = ServerBrowserPage.DIAGNOSTIC_BUFFER_LIMIT,
) => {
  buffer.push(entry);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
};

/** A navigation's URL: `environment-port` targets are this machine's loopback ports. */
const navigationUrl = (input: PreviewAutomationNavigateInput) => {
  if (input.url !== undefined) return normalizePreviewUrl(input.url);
  const target = input.target!;
  if (target.kind === "url") return normalizePreviewUrl(target.url);
  const path = target.path ?? "";
  return `${target.protocol ?? "http"}://localhost:${target.port}${path === "" || path.startsWith("/") ? path : `/${path}`}`;
};

const failure = (message: string) =>
  new ServerBrowserPage.ServerBrowserOperationError("PreviewAutomationExecutionError", message);

/**
 * Headless Chromium on the thread's machine, launched on first use. Tabs
 * share one browser and one storage-less context.
 */
export const machineTabs = (options: {
  readonly executable: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}): TabSource => {
  const contexts = new ServerBrowserContexts({
    // Only named profiles keep storage on disk, and this browser opens none.
    profilesDir: "",
    executable: async () => {
      if (options.executable === undefined || options.executable === "")
        throw failure(
          `This machine has no headless browser; ${BROWSER_EXECUTABLE_ENV} names it in the Runner image.`,
        );
      return options.executable;
    },
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return {
    newPage: async () =>
      (await contexts.contextFor(INCOGNITO_BROWSER_PROFILE_ID, "agent")).newPage(),
    close: () => contexts.close(),
  };
};

/** The machine's headless browser alone, where every URL opens: a development host, and tests. */
export const makeHeadlessBrowser = (options: {
  readonly executable: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}): BrowserBackend => makeRunnerBrowser({ machine: machineTabs(options), person: null });

/**
 * One set of tabs over the machine's browser and, when the thread has one,
 * the person's. Without `person` every URL opens on the machine.
 */
export const makeRunnerBrowser = (sources: {
  readonly machine: TabSource;
  readonly person: TabSource | null;
}): BrowserBackend => {
  const tabs = new Map<string, Tab>();
  let current: string | null = null;
  /** Tab ids of the person's pages while its browser is let go, by CDP target, for when it's back. */
  const parked = new Map<string, string>();
  /** The current tab, when it is one of those. */
  let parkedCurrent: string | null = null;

  const routeOf = (url: string): BrowserRoute =>
    sources.person === null ? "machine" : browserFor(url);
  const sourceOf = (route: BrowserRoute) =>
    route === "person" && sources.person !== null ? sources.person : sources.machine;

  /** A tab for `page`, made current unless `background`. Its tab id is new unless given. */
  const track = async (
    page: Page,
    route: BrowserRoute,
    options: { readonly tabId?: string; readonly background?: boolean } = {},
  ): Promise<Tab> => {
    const cdp = await page
      .context()
      .newCDPSession(page)
      .catch(async (cause: unknown) => {
        await page.close().catch(constVoid);
        throw cause;
      });
    const targetId =
      route === "person"
        ? await cdp
            .send("Target.getTargetInfo")
            .then((info) => info.targetInfo.targetId)
            .catch(() => null)
        : null;
    const parkedId = targetId === null ? undefined : parked.get(targetId);
    if (targetId !== null) parked.delete(targetId);
    const tab: Tab = {
      tabId: options.tabId ?? parkedId ?? `tab-${NodeCrypto.randomUUID().slice(0, 8)}`,
      route,
      page,
      cdp,
      targetId,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      dialog: null,
    };
    const now = () => new Date().toISOString();
    page.on("console", (message) =>
      pushBounded(tab.consoleEntries, {
        level: message.type(),
        text: message.text().slice(0, 2_000),
        timestamp: now(),
      }),
    );
    // Uncaught exceptions never reach the console API, but they are what breaks a page.
    page.on("pageerror", (error) =>
      pushBounded(tab.consoleEntries, {
        level: "error",
        text: (error.stack ?? error.message).slice(0, 2_000),
        timestamp: now(),
        source: "pageerror",
      }),
    );
    page.on("response", (response) =>
      pushBounded(tab.networkEntries, {
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        failed: false,
        timestamp: now(),
      }),
    );
    page.on("requestfailed", (request) =>
      pushBounded(tab.networkEntries, {
        url: request.url(),
        method: request.method(),
        status: null,
        failed: true,
        errorText: request.failure()?.errorText ?? "",
        timestamp: now(),
      }),
    );
    page.on("dialog", (dialog) => {
      tab.dialog = dialog;
    });
    page.on("close", () => {
      // A tab that moved to the other browser keeps its id on the new page.
      if (tabs.get(tab.tabId) !== tab) return;
      tabs.delete(tab.tabId);
      const wasCurrent = current === tab.tabId;
      if (wasCurrent) current = null;
      // Letting the person's browser go closes its pages here, not there.
      if (tab.targetId !== null) {
        if (wasCurrent) parkedCurrent = tab.tabId;
        parked.set(tab.targetId, tab.tabId);
        if (parked.size > TAB_LIMIT * 2) parked.delete(parked.keys().next().value!);
      }
    });
    tabs.set(tab.tabId, tab);
    if (options.background !== true) current = tab.tabId;
    if (parkedCurrent === tab.tabId) {
      current = tab.tabId;
      parkedCurrent = null;
    }
    return tab;
  };

  /** A page in `route`'s browser, or on the machine when the cloud has no person's browser. */
  const pageOn = async (route: BrowserRoute) => {
    const page = await sourceOf(route).newPage();
    if (page !== null) return { page, route };
    const machine = await sources.machine.newPage();
    if (machine === null) throw failure("This machine has no browser.");
    return { page: machine, route: "machine" as const };
  };

  const createTab = async (route: BrowserRoute): Promise<Tab> => {
    const oldest = tabs.values().next().value;
    if (oldest !== undefined && tabs.size >= TAB_LIMIT) await oldest.page.close().catch(constVoid);
    const opened = await pageOn(route);
    return track(opened.page, opened.route);
  };

  /** Pages the person's browser still has open after reconnecting, as tabs again. */
  const adopt = async () => {
    const held = new Set([...tabs.values()].map((tab) => tab.page));
    const loose = (sources.person?.openPages?.() ?? []).filter(
      (page) => !held.has(page) && !page.isClosed(),
    );
    // Within the tab limit; pages beyond it close, as opening one more tab would close the oldest.
    const room = Math.max(0, TAB_LIMIT - tabs.size);
    await Promise.all([
      ...loose
        .slice(0, room)
        .map((page) => track(page, "person", { background: true }).catch(constVoid)),
      ...loose.slice(room).map((page) => page.close().catch(constVoid)),
    ]);
  };

  /** `tab`, or the tab that replaces it in the browser `route` names, under the same id. */
  const onRoute = async (tab: Tab, route: BrowserRoute): Promise<Tab> => {
    if (tab.route === route) return tab;
    const page = await sourceOf(route).newPage();
    // Without a person's browser, a machine tab stays where it is.
    if (page === null && tab.route === "machine") return tab;
    const opened = page === null ? await pageOn("machine") : { page, route };
    const moved = await track(opened.page, opened.route, { tabId: tab.tabId });
    await tab.page.close().catch(constVoid);
    return moved;
  };

  /** The tab calls without a tabId act on, while it is open. */
  const currentTab = () => (current === null ? undefined : tabs.get(current));

  /** The tab, reconnecting the person's browser when it holds the tab while let go. */
  const findTab = async (input: TabInput): Promise<Tab> => {
    const wanted = input.tabId ?? (current === null ? parkedCurrent : null);
    if (wanted !== null && !tabs.has(wanted) && [...parked.values()].includes(wanted)) {
      if (await sources.person?.reopen?.()) await adopt();
    }
    return requireTab(input);
  };

  const requireTab = (input: TabInput): Tab => {
    const tabId = input.tabId ?? current;
    const tab = tabId === null ? undefined : tabs.get(tabId);
    if (tab !== undefined) return tab;
    throw failure(
      input.tabId === undefined
        ? "No browser tab is open. Call preview_open first."
        : `Tab ${input.tabId} is not open; preview_status lists the open tabs.`,
    );
  };

  /** An action on a tab, refused while a dialog waits, and kept in the tab's timeline. */
  const act = async <A>(
    input: TabInput,
    action: string,
    run: (tab: Tab) => Promise<A>,
  ): Promise<A> => {
    const tab = await findTab(input);
    if (tab.dialog !== null)
      throw failure("A browser dialog is pending. Read preview_status and use preview_dialog.");
    const event: {
      -readonly [K in keyof PreviewAutomationActionEvent]: PreviewAutomationActionEvent[K];
    } = {
      id: NodeCrypto.randomUUID(),
      action,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    pushBounded(tab.actionTimeline, event, ACTION_TIMELINE_LIMIT);
    const release = sourceOf(tab.route).use?.() ?? constVoid;
    try {
      const result = await run(tab);
      event.status = "succeeded";
      return result;
    } catch (cause) {
      event.status = "failed";
      event.error = cause instanceof Error ? (cause.message.split("\n")[0] ?? "") : String(cause);
      throw ServerBrowserPage.toOperationError(cause);
    } finally {
      event.completedAt = new Date().toISOString();
      release();
    }
  };

  const statusOf = async (tab: Tab | undefined): Promise<PreviewAutomationStatus> => {
    const viewport = tab?.page.viewportSize() ?? undefined;
    return {
      available: true,
      visible: false,
      tabId: tab?.tabId ?? null,
      url: tab?.page.url() ?? null,
      // Reading the title waits behind an open dialog.
      title:
        tab === undefined
          ? null
          : tab.dialog !== null
            ? ""
            : await tab.page.title().catch(() => ""),
      loading: false,
      dialog:
        tab?.dialog == null
          ? null
          : {
              type: tab.dialog.type(),
              message: tab.dialog.message(),
              defaultValue: tab.dialog.defaultValue(),
            },
      ...(viewport === undefined ? {} : { viewport }),
      tabs: [...tabs.values()].map((each) => ({
        tabId: each.tabId,
        url: each.page.url(),
        owner: "agent" as const,
        ownedByCaller: true,
        visible: false,
      })),
    };
  };

  const goto = (tab: Tab, url: string, input: PreviewAutomationNavigateInput) =>
    tab.page
      .goto(url, {
        timeout: input.timeoutMs ?? NAVIGATION_TIMEOUT_MS,
        waitUntil:
          input.readiness === "domContentLoaded"
            ? "domcontentloaded"
            : input.readiness === "none"
              ? "commit"
              : "load",
      })
      .then(constVoid);

  return {
    status: async (input) => {
      await adopt();
      return statusOf(input.tabId === undefined ? currentTab() : await findTab(input));
    },
    open: async (input) => {
      const reuse = input.reuseExistingTab ?? true;
      const url = input.url === undefined ? undefined : normalizePreviewUrl(input.url);
      const route = url === undefined ? "machine" : routeOf(url);
      const found =
        input.tabId !== undefined ? await findTab(input) : reuse ? currentTab() : undefined;
      const tab =
        found === undefined
          ? await createTab(route)
          : url === undefined
            ? found
            : await onRoute(found, route);
      current = tab.tabId;
      if (url !== undefined)
        await act({ tabId: tab.tabId }, "navigate", (each) => goto(each, url, { url }));
      await adopt();
      return statusOf(tab);
    },
    navigate: async (input) => {
      const url = navigationUrl(input);
      const route = routeOf(url);
      const found = input.tabId === undefined ? currentTab() : await findTab(input);
      const tab = found === undefined ? await createTab(route) : await onRoute(found, route);
      await act({ tabId: tab.tabId }, "navigate", (each) => goto(each, url, input));
      await adopt();
      return statusOf(tab);
    },
    dialog: async (input) => {
      const tab = await findTab(input);
      const dialog = tab.dialog;
      if (dialog === null) throw failure("No dialog is pending.");
      if (input.accept) await dialog.accept(input.promptText);
      else await dialog.dismiss();
      if (tab.dialog === dialog) tab.dialog = null;
      ServerBrowserPage.invalidateRefs(tab.page);
      return statusOf(tab);
    },
    resize: (input) =>
      act(input, "resize", async (tab) => {
        const setting = resolvePreviewViewport(input);
        // A headless page has no panel to fill: fill keeps the default desktop size.
        const size =
          setting._tag === "fill"
            ? { width: 1280, height: 800 }
            : { width: setting.width, height: setting.height };
        await tab.page.setViewportSize(size);
        return { tabId: tab.tabId, setting, viewport: size };
      }),
    setColorScheme: (input) =>
      act(input, "setColorScheme", async (tab) => {
        await tab.page.emulateMedia({
          colorScheme: input.colorScheme === "system" ? null : input.colorScheme,
        });
        return { tabId: tab.tabId, colorScheme: input.colorScheme };
      }),
    snapshot: (input) =>
      act(input, "snapshot", (tab) =>
        ServerBrowserPage.snapshot({ ...tab, renderScale: RENDER_SCALE }),
      ),
    click: (input) =>
      act(input, "click", (tab) => ServerBrowserPage.click(tab.page, input).then(constVoid)),
    type: (input) => act(input, "type", (tab) => ServerBrowserPage.type(tab.page, input)),
    hover: (input) => act(input, "hover", (tab) => ServerBrowserPage.hover(tab.page, input)),
    select: (input) => act(input, "select", (tab) => ServerBrowserPage.select(tab.page, input)),
    drag: (input) => act(input, "drag", (tab) => ServerBrowserPage.drag(tab.page, input)),
    upload: (input) =>
      act(input, "upload", async (tab) => {
        // No viewer answers file pickers here, so files go straight to an input.
        if (!(await ServerBrowserPage.setInputFiles(tab.page, input)))
          throw failure("Pass the locator of the page's <input type=file>.");
      }),
    press: (input) => act(input, "press", (tab) => ServerBrowserPage.press(tab.page, input)),
    scroll: (input) => act(input, "scroll", (tab) => ServerBrowserPage.scroll(tab.page, input)),
    evaluate: (input) =>
      act(input, "evaluate", (tab) =>
        ServerBrowserPage.evaluate(tab.cdp, input, EVALUATE_TIMEOUT_MS),
      ),
    waitFor: (input) =>
      act(input, "waitFor", (tab) => ServerBrowserPage.waitFor(tab.page, input).then(constVoid)),
    close: async () => {
      await Promise.all([sources.machine.close(), sources.person?.close() ?? Promise.resolve()]);
    },
  };
};
