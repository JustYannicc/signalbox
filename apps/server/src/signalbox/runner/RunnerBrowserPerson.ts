// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owns a Playwright connection outside the Effect runtime.
import * as NodeModule from "node:module";

import type {
  BrowserSessionAnswer,
  BrowserSignInAnswer,
} from "@signalbox/runner-protocol/BrowserProtocol";
import { constVoid } from "effect/Function";
import type { Browser, BrowserContext } from "playwright-core";

import * as ServerBrowserPage from "../../preview/ServerBrowserPage.ts";
import type { TabSource } from "./RunnerBrowser.ts";

/**
 * The person's browser (#574): a headless Kernel browser built from their
 * persistent profile, which the cloud opens for the thread
 * (`BrowserProtocol.ts`). This machine only ever holds the session's CDP
 * endpoint. Tabs open in the browser's own context, the one the profile's
 * cookies live in.
 *
 * Kernel bills a browser until five seconds after the last CDP activity, so
 * the connection drops once no tab action has run for `idleMs`. The browser
 * then waits in standby, unbilled, keeping its tabs: the next action
 * reconnects to the same session, through the cloud, and the tabs come back.
 * Kernel deletes a browser left in standby, saving the profile; closing this
 * source (the thread's machine stopping) deletes it at once.
 *
 * Signing in (#576) lets go of the session too: the cloud ends it before it
 * logs the profile in, so the next connection is a new session that loads
 * the login.
 */

export interface PersonSession {
  /** The thread's session, opened by the cloud as the thread's owner. */
  readonly open: () => Promise<BrowserSessionAnswer>;
  /** Deletes the session, which saves the profile. */
  readonly end: (sessionId: string) => Promise<void>;
  /** Signs the profile in to `site` from 1Password, ending the thread's session first. */
  readonly signIn: (site: string) => Promise<BrowserSignInAnswer>;
}

/** Long enough to span an agent thinking between steps, short enough not to bill a pause. */
const PERSON_BROWSER_IDLE_MS = 60_000;

// Playwright needs its files on disk; createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const connectOverCdp = (cdpWsUrl: string) =>
  (
    requirePlaywright("playwright-core") as typeof import("playwright-core")
  ).chromium.connectOverCDP(cdpWsUrl, { timeout: 30_000 });

interface Connection {
  readonly browser: Browser;
  readonly context: BrowserContext;
}

const refused = (message: string) =>
  new ServerBrowserPage.ServerBrowserOperationError("PreviewAutomationExecutionError", message);

export const personTabs = (
  session: PersonSession,
  options: {
    readonly idleMs?: number;
    readonly connect?: (cdpWsUrl: string) => Promise<Browser>;
    /** Runs `drop` once the browser has been idle; returns how to cancel that. */
    readonly onIdle?: (drop: () => Promise<void>, ms: number) => () => void;
  } = {},
): TabSource => {
  const idleMs = options.idleMs ?? PERSON_BROWSER_IDLE_MS;
  const connect = options.connect ?? connectOverCdp;
  const onIdle =
    options.onIdle ??
    ((drop: () => Promise<void>, ms: number) => {
      const timer = setTimeout(() => void drop(), ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });

  let connection: Connection | null = null;
  let connecting: Promise<Connection | null> | null = null;
  /** The last session this machine used, which closing ends. */
  let sessionId: string | null = null;
  /** The cloud has no person's browser; it won't grow one while this machine runs. */
  let unconfigured = false;
  let closed = false;
  let inFlight = 0;
  /** A sign-in under way: nothing reconnects until the cloud has logged the profile in. */
  let signingIn: Promise<unknown> | null = null;
  let cancelIdle: () => void = constVoid;

  const disconnect = async () => {
    cancelIdle();
    cancelIdle = constVoid;
    const open = connection;
    connection = null;
    // Closing a connectOverCDP browser drops the connection; Kernel keeps the browser.
    await open?.browser.close().catch(constVoid);
  };

  const armIdle = () => {
    cancelIdle();
    cancelIdle = inFlight === 0 && connection !== null ? onIdle(disconnect, idleMs) : constVoid;
  };

  /** Marks a tab action until the returned release; the idle clock runs only between actions. */
  const use = () => {
    inFlight += 1;
    armIdle();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      armIdle();
    };
  };

  /** The open connection, a new one, or null when this cloud has no person's browser. */
  const open = async (): Promise<Connection | null> => {
    await signingIn?.catch(constVoid);
    if (closed) throw refused("The thread's browser has closed.");
    if (unconfigured) return null;
    if (connection !== null && connection.browser.isConnected()) return connection;
    connecting ??= (async () => {
      const answer = await session.open();
      if (answer._tag === "unconfigured") {
        unconfigured = true;
        return null;
      }
      if (answer._tag === "refused") throw refused(answer.message);
      sessionId = answer.sessionId;
      const browser = await connect(answer.cdpWsUrl);
      if (closed) {
        // The machine stopped while this connected: end what it opened.
        await browser.close().catch(constVoid);
        await session.end(answer.sessionId).catch(constVoid);
        throw refused("The thread's browser has closed.");
      }
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const opened: Connection = { browser, context };
      browser.on("disconnected", () => {
        if (connection === opened) connection = null;
      });
      connection = opened;
      armIdle();
      return opened;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  };

  return {
    newPage: async () => {
      const release = use();
      try {
        const opened = await open();
        return opened === null ? null : await opened.context.newPage();
      } finally {
        release();
      }
    },
    openPages: () => (connection === null ? [] : connection.context.pages()),
    reopen: async () => {
      const release = use();
      try {
        return (await open()) !== null;
      } finally {
        release();
      }
    },
    use,
    signIn: async (site) => {
      const release = use();
      const signedIn = (async () => {
        if (closed) throw refused("The thread's browser has closed.");
        await connecting?.catch(constVoid);
        // The cloud ends the session it signs in around; the next open gets a new one.
        await disconnect();
        return session.signIn(site);
      })();
      signingIn = signedIn;
      try {
        return await signedIn;
      } finally {
        if (signingIn === signedIn) signingIn = null;
        release();
      }
    },
    close: async () => {
      closed = true;
      await connecting?.catch(constVoid);
      await disconnect();
      const ended = sessionId;
      sessionId = null;
      if (ended !== null) await session.end(ended).catch(constVoid);
    },
  };
};
