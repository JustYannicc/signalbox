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
import type { BrowserContext, CDPSession, Dialog, Page } from "playwright-core";

import { ServerBrowserContexts } from "../../preview/ServerBrowserContexts.ts";
import * as ServerBrowserPage from "../../preview/ServerBrowserPage.ts";

/**
 * The browser an agent in a cloud thread checks its own work with (#402):
 * pages on the thread's machine, so `localhost` is the thread's dev server.
 * `RunnerBrowserTools.ts` serves it to the harnesses as the same `preview_*`
 * tools agents use locally. Behind those tools, `BrowserBackend` is the seam
 * the cloud browser provider (#343) replaces for real sites.
 *
 * Every tab is the agent's own, with throwaway storage and no person's
 * cookies: nobody else drives this browser, so there is no takeover, no
 * profile and no live view.
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

interface Tab {
  readonly tabId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
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
export const makeHeadlessBrowser = (options: {
  readonly executable: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}): BrowserBackend => {
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
  const tabs = new Map<string, Tab>();
  let current: string | null = null;

  const context = (): Promise<BrowserContext> =>
    contexts.contextFor(INCOGNITO_BROWSER_PROFILE_ID, "agent");

  const createTab = async (): Promise<Tab> => {
    const oldest = tabs.values().next().value;
    if (oldest !== undefined && tabs.size >= TAB_LIMIT) await oldest.page.close().catch(constVoid);
    const page = await (await context()).newPage();
    const cdp = await page
      .context()
      .newCDPSession(page)
      .catch(async (cause: unknown) => {
        await page.close().catch(constVoid);
        throw cause;
      });
    const tab: Tab = {
      tabId: `tab-${NodeCrypto.randomUUID().slice(0, 8)}`,
      page,
      cdp,
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
      tabs.delete(tab.tabId);
      if (current === tab.tabId) current = null;
    });
    tabs.set(tab.tabId, tab);
    current = tab.tabId;
    return tab;
  };

  /** The tab calls without a tabId act on, while it is open. */
  const currentTab = () => (current === null ? undefined : tabs.get(current));

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
    const tab = requireTab(input);
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
    status: (input) => statusOf(input.tabId === undefined ? currentTab() : requireTab(input)),
    open: async (input) => {
      const reuse = input.reuseExistingTab ?? true;
      const tab =
        input.tabId !== undefined
          ? requireTab(input)
          : ((reuse ? currentTab() : undefined) ?? (await createTab()));
      current = tab.tabId;
      if (input.url !== undefined)
        await act({ tabId: tab.tabId }, "navigate", (each) =>
          goto(each, normalizePreviewUrl(input.url!), { url: input.url! }),
        );
      return statusOf(tab);
    },
    navigate: async (input) => {
      const tab =
        input.tabId === undefined ? (currentTab() ?? (await createTab())) : requireTab(input);
      await act({ tabId: tab.tabId }, "navigate", (each) =>
        goto(each, navigationUrl(input), input),
      );
      return statusOf(tab);
    },
    dialog: async (input) => {
      const tab = requireTab(input);
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
    close: () => contexts.close(),
  };
};
