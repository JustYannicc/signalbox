import type { SignInFill } from "@t3tools/contracts/signalboxSignIn";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Redacted from "effect/Redacted";

import {
  fillLoginFormScript,
  findLoginFormScript,
  type LoginForm,
  parseLoginForm,
} from "./loginFormScripts.ts";

export {
  type FillResult,
  fillLoginFormScript,
  findLoginFormScript,
  type LoginForm,
  type LoginFormKinds,
  parseLoginForm,
} from "./loginFormScripts.ts";

/**
 * A device signing its own tab in from the person's 1Password (#586), the
 * same on every engine (the desktop `<webview>`, the mobile WebView). The
 * engine looks for a login form only while the tab is in front of the
 * person, asks the cloud for exactly what the form's current step needs, and
 * fills and submits it in the page (`loginFormScripts.ts`). A tab that only
 * synced to this device never signs in, so a phone isn't flooded with "is
 * this you?" prompts.
 *
 * There's no debugger, no synthetic browser input and no changed user agent,
 * which is what sites' automation checks look for.
 */

/** How often an engine looks at a page in front of the person, at most. */
export const SIGN_IN_LOOK_INTERVAL_MS = 2_500;

/** Whether a tab's URL is a page worth signing in to: a real web page, not this machine's. */
export function signsIn(url: string | null): url is string {
  if (url === null) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === "https:" && !isLocalLoopbackHost(hostname) && !hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/** How soon the same step asking again means the site turned the login down. */
const REPEAT_MS = 60_000;
/** How many steps one sign-in may take: username, password, code, and a spare. */
const MAX_STEPS = 4;
const STEP_WINDOW_MS = 120_000;
/** How long a tab stays quiet after a site has nothing to fill or turned a login down. */
const QUIET_MS = 10 * 60_000;
/** How long after 1Password couldn't be read the tab asks again. */
const RETRY_MS = 60_000;
/** The longest a page without a login form waits between looks, until it navigates. */
const IDLE_MAX_MS = 20_000;
/** How long an engine waits for a page to answer a script before taking it as no answer. */
export const SIGN_IN_EVALUATE_TIMEOUT_MS = 3_000;

/** One tab's sign-ins on this device, kept while it's open here. */
export interface SignInRunner {
  readonly steps: ReadonlyArray<{ readonly step: string; readonly at: number }>;
  /** The login this sign-in fills from, so a two-step site stays on one account. */
  readonly item: { readonly origin: string; readonly id: string } | null;
  /** Asks nothing before this: nothing to fill here, or the site turned it down. */
  readonly quietUntil: number;
  /** The page that last showed no login form, and how often in a row: looks there slow down. */
  readonly idle: { readonly url: string; readonly misses: number; readonly at: number } | null;
}

export const initialSignInRunner: SignInRunner = {
  steps: [],
  item: null,
  quietUntil: 0,
  idle: null,
};

const stepOf = (form: LoginForm) => `${form.origin}${form.path}|${form.kinds.join(",")}`;

/**
 * What to do about a login form the page shows now: `fill` a step, or
 * `wait` (a quiet tab). The same step showing up again soon after it was
 * filled is the site saying no, so the tab goes quiet instead of trying the
 * same values in a loop.
 */
export function nextSignIn(
  runner: SignInRunner,
  form: LoginForm,
  now: number,
): { readonly _tag: "fill" | "wait"; readonly runner: SignInRunner } {
  if (now < runner.quietUntil) return { _tag: "wait", runner };
  const step = stepOf(form);
  const recent = runner.steps.filter((each) => now - each.at < STEP_WINDOW_MS);
  const repeated = runner.steps.some((each) => each.step === step && now - each.at < REPEAT_MS);
  if (repeated || recent.length >= MAX_STEPS) {
    return { _tag: "wait", runner: { ...runner, steps: [], quietUntil: now + QUIET_MS } };
  }
  return { _tag: "fill", runner: { ...runner, steps: [...recent, { step, at: now }] } };
}

/** The tab after the cloud answered a step at `origin`. */
export function afterSignIn(
  runner: SignInRunner,
  origin: string,
  answer: SignInFill,
  now: number,
): SignInRunner {
  switch (answer._tag) {
    case "filled":
      return { ...runner, item: { origin, id: answer.item } };
    case "unavailable":
      return { ...runner, quietUntil: now + RETRY_MS };
    case "ask":
    case "not-owner":
    case "no-login":
      return { ...runner, quietUntil: now + QUIET_MS };
  }
}

/** One engine's page, as signing in reaches it. */
export interface SignInEngine {
  /**
   * Runs a script in the page and resolves to its value; null when the page
   * couldn't run it or didn't answer within `SIGN_IN_EVALUATE_TIMEOUT_MS`.
   * It always settles, so a stuck page never stalls the tab's sign-ins.
   */
  readonly evaluate: (script: string) => Promise<unknown>;
  /** Where the engine itself says the page is; the page's own say-so never decides the origin. */
  readonly url: () => string | null;
}

/** The cloud's fill for one step, for the login an earlier step used; null when the call failed. */
export type SignInAsk = (form: LoginForm, item: string | null) => Promise<SignInFill | null>;

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const evaluateIn = (engine: SignInEngine, script: string) =>
  engine.evaluate(script).catch(() => null);

/**
 * Looks at the page once and fills its login form's current step if the
 * runner says to: the engine calls it while the tab is in front of the
 * person. Resolves to the runner for the next look.
 */
export async function signInStep(input: {
  readonly engine: SignInEngine;
  readonly runner: SignInRunner;
  readonly now: () => number;
  readonly ask: SignInAsk;
}): Promise<SignInRunner> {
  const { engine, runner } = input;
  const url = engine.url();
  const now = input.now();
  if (!signsIn(url) || now < runner.quietUntil) return runner;
  const idle = runner.idle?.url === url ? runner.idle : null;
  if (idle && now - idle.at < Math.min(IDLE_MAX_MS, SIGN_IN_LOOK_INTERVAL_MS * 2 ** idle.misses)) {
    return runner;
  }
  const form = parseLoginForm(await evaluateIn(engine, findLoginFormScript));
  if (form === null || form.origin !== originOf(url)) {
    return { ...runner, idle: { url, misses: (idle?.misses ?? 0) + 1, at: now } };
  }
  const next = nextSignIn({ ...runner, idle: null }, form, now);
  if (next._tag === "wait") return next.runner;
  const item = next.runner.item?.origin === form.origin ? next.runner.item.id : null;
  const answer = (await input.ask(form, item)) ?? {
    _tag: "unavailable",
    message: "The sign-in request failed.",
  };
  const after = afterSignIn(next.runner, form.origin, answer, input.now());
  // The page may have moved on while the cloud answered; the script checks again in the page.
  const current = engine.url();
  if (answer._tag !== "filled" || current === null || originOf(current) !== form.origin) {
    return after;
  }
  const result = await evaluateIn(
    engine,
    fillLoginFormScript({
      origin: form.origin,
      ...(answer.username === undefined ? {} : { username: answer.username }),
      ...(answer.password === undefined ? {} : { password: Redacted.value(answer.password) }),
      ...(answer.totp === undefined ? {} : { totp: Redacted.value(answer.totp) }),
    }),
  );
  // Nothing went in: this login isn't carried on to the next step.
  return result === "filled" ? after : { ...after, item: next.runner.item };
}
