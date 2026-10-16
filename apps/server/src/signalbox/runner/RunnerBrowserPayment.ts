import { AUTOMATION_TOOLS } from "@signalbox/automations/tools/declarations";
import type { AutomationRunStatus } from "@t3tools/contracts";
import type { AgentBrowserHandoff } from "@t3tools/contracts/signalboxPreviews";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Page } from "playwright-core";

import * as ServerBrowserPage from "../../preview/ServerBrowserPage.ts";
import type { AutomationCaller } from "./RunnerAutomationTools.ts";
import type { BrowserBackend, PageGuard } from "./RunnerBrowser.ts";
import { AGENT_WAIT_MS, defaultTimer, type Timer } from "./RunnerBrowserControl.ts";
import { CARD_FIELD } from "./RunnerBrowserRecorder.ts";
import { answer } from "./RunnerBrowserTools.ts";
import { register } from "./RunnerContextTools.ts";

/**
 * Payments go back to the person (#579). They are the one step of the
 * agent's browsing a person finishes: sign-ins, codes and CAPTCHAs never are.
 *
 * A tab is handed over when the agent calls `needs_you_payment`, or by
 * itself (`pageKind`, a fixed rule in code): before the agent clicks or
 * presses on a page that takes a card, or once an action landed on a 3-D
 * Secure check. Filling in the rest of a checkout stays the agent's. From then on the agent's actions
 * on the tab wait, reads included, and the "Payment" automation
 * (`builtin:payment`) asks the person as a needs-you. They finish the payment
 * in the agent's browser through the live mirror (or in their own browser,
 * when the cart lives in their account) and answer Done or Failed. The tab
 * goes back to the agent with that outcome, which `needs_you_payment` hands
 * it; the agent keeps its turn, and so its browser, while it waits.
 */

const PAYMENT_AUTOMATION = "builtin:payment";
/** How often the Runner reads whether the person answered, while the agent waits on it. */
export const PAYMENT_POLL_MS = 2_000;
/** The same while nobody waits: the agent hears the outcome on its next call. */
const PAYMENT_IDLE_POLL_MS = 15_000;
/** How long a payment waits on the person before it's withdrawn. */
export const PAYMENT_PATIENCE_MS = 30 * 60_000;

const minutes = (ms: number) => `${Math.round(ms / 60_000)} minutes`;

export const REACHED_PAYMENT =
  "This page takes a payment, so it's handed to the person to finish. Call needs_you_payment to wait for how it went; until then you can't read or act on this tab.";
export const ALREADY_ANSWERED =
  "The person already answered for this payment; needs_you_payment tells you how it went. Don't act on the payment page yourself: call needs_you_payment again only if they want another try.";
export const NOT_A_PAYMENT =
  "This page asks to sign in or prove you're human, not to pay. Sign-ins, codes and CAPTCHAs never go to the person: call sign_in, or say in your reply what's blocking you.";
const STILL_WAITING =
  "The person hasn't finished the payment yet. Call needs_you_payment again to keep waiting. Don't end your turn: the browser closes with the machine.";
const PAID =
  "The person finished the payment. Carry on from where the tab is now, starting with a fresh snapshot.";
const NOT_PAID =
  "The payment didn't go through. Tell the person where things stand, and don't try to pay another way.";

/** What a page is, as far as handing it to the person goes. */
export type PageKind = "payment" | "sign-in" | "captcha" | "other";

/** Card fields, a password and a one-time code, among a frame's visible inputs. */
interface FrameSignals {
  readonly card: boolean;
  readonly password: boolean;
  readonly code: boolean;
}

/**
 * Runs in each frame of the page. It reads attributes only, never values, and
 * lays out only the inputs that match. A string, so no bundler helper ends up
 * in the page.
 */
const FRAME_SIGNALS = `(() => {
  const card = ${CARD_FIELD};
  const signals = { card: false, password: false, code: false };
  for (const input of document.querySelectorAll("input")) {
    const kind = card(input)
      ? "card"
      : input.type === "password"
        ? "password"
        : /(^|\\s)one-time-code(\\s|$)/i.test(input.getAttribute("autocomplete") || "")
          ? "code"
          : null;
    if (kind === null || signals[kind]) continue;
    signals[kind] =
      input.getClientRects().length > 0 && getComputedStyle(input).visibility !== "hidden";
  }
  return signals;
})()`;

/** Runs of 13 to 19 digits, spaced or dashed the way card numbers are written. */
const DIGIT_RUN = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;

const passesLuhn = (digits: string) => {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
};

/**
 * `text` with every card number in it masked to its last four digits. A card
 * the person typed stays in its field after they hand the tab back, so what
 * the agent reads of the person's browser goes through this (`RunnerBrowser.ts`).
 */
export const maskCardNumbers = (text: string): string =>
  text.replace(DIGIT_RUN, (run) => {
    const digits = run.replace(/[ -]/g, "");
    return passesLuhn(digits) ? `•••• ${digits.slice(-4)}` : run;
  });

/** Hosts that run 3-D Secure checks: a bank's access control server, or Cardinal (Visa). */
const SECURE_HOSTS = [/^acs[\w-]*\./i, /(^|\.)cardinalcommerce\.com$/i];
/** A 3-D Secure check inside a frame of the shop's page, e.g. Stripe's `hooks.stripe.com/3d_secure`. */
const SECURE_FRAME = /3d[-_]?secure|three[-_]?d[-_]?secure|threeds|3ds2/i;
const CAPTCHA_HOSTS = [
  /(^|\.)recaptcha\.net$/i,
  /(^|\.)hcaptcha\.com$/i,
  /^challenges\.cloudflare\.com$/i,
  /(^|\.)arkoselabs\.com$/i,
];
const isCaptcha = (url: URL) =>
  CAPTCHA_HOSTS.some((host) => host.test(url.hostname)) ||
  (/(^|\.)google\.com$/i.test(url.hostname) && url.pathname.startsWith("/recaptcha"));

const parse = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** Frames looked at, at most; one stuck frame can't hold the agent's action up long. */
const FRAME_LIMIT = 30;
const FRAME_TIMEOUT_MS = 2_000;

/** `promise`, or null once `ms` passed. */
const within = <A>(promise: Promise<A>, ms: number) => {
  let cancel = () => {};
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      cancel = defaultTimer(() => resolve(null), ms);
    }),
  ]).finally(() => cancel());
};

/**
 * Whether `page` takes a payment: visible card fields in any frame, or a
 * 3-D Secure check. Otherwise a CAPTCHA or a sign-in (a password or a
 * one-time code) is said as such, so neither is ever handed over. `after` an
 * action, only a 3-D Secure check counts, once the page it landed on loaded:
 * card fields alone mean the agent may still fill in the rest.
 */
export const pageKind = async (
  page: Page,
  options: { readonly after?: boolean } = {},
): Promise<PageKind> => {
  if (options.after === true)
    await page
      .waitForLoadState("domcontentloaded", { timeout: FRAME_TIMEOUT_MS })
      .catch(() => undefined);
  const frames = page.frames().slice(0, FRAME_LIMIT);
  const urls = frames.map((frame) => ({
    top: frame === page.mainFrame(),
    url: parse(frame.url()),
  }));
  const secure = urls.some(
    ({ top, url }) =>
      url !== null &&
      (SECURE_HOSTS.some((host) => host.test(url.hostname)) ||
        (!top && SECURE_FRAME.test(`${url.hostname}${url.pathname}`))),
  );
  if (secure) return "payment";
  if (options.after === true) return "other";
  const signals = await Promise.all(
    frames.map((frame) =>
      within(
        frame.evaluate<FrameSignals>(FRAME_SIGNALS).catch(() => null),
        FRAME_TIMEOUT_MS,
      ),
    ),
  );
  const any = (key: keyof FrameSignals) => signals.some((each) => each?.[key] === true);
  if (any("card")) return "payment";
  if (urls.some(({ url }) => url !== null && isCaptcha(url))) return "captcha";
  if (any("password") || any("code")) return "sign-in";
  return "other";
};

/** The automation run that asks the person, as the cloud's engine serves it. */
export interface PaymentAsker {
  /** Starts `builtin:payment` attached to the thread; answers its run id. */
  readonly start: (
    tabId: string,
    input: {
      readonly site: string;
      readonly note: string | null;
      readonly ownBrowserUrl: string | null;
    },
  ) => Promise<string>;
  readonly read: (
    runId: string,
  ) => Promise<{ readonly status: AutomationRunStatus; readonly output: unknown }>;
  readonly cancel: (runId: string) => Promise<void>;
}

const decodeStarted = Schema.decodeUnknownEffect(AUTOMATION_TOOLS.automation_run.success);
const decodeRead = Schema.decodeUnknownEffect(AUTOMATION_TOOLS.automation_run_read.success);

/** The asker on the cloud's automation engine, for `threadId`, in the automation tools' own shapes. */
export const paymentAsker = (ask: AutomationCaller, threadId: string): PaymentAsker => ({
  start: (tabId, input) =>
    Effect.runPromise(
      ask(
        "automation_run",
        {
          automationId: PAYMENT_AUTOMATION,
          input: { threadId, ...input },
          attach: { threadId, key: `payment:${tabId}`, label: `Paying on ${input.site}` },
        },
        false,
      ).pipe(
        Effect.flatMap(decodeStarted),
        Effect.map((started) => started.run.runId),
      ),
    ),
  // Not retried here: the next poll reads again anyway.
  read: (runId) =>
    Effect.runPromise(
      ask("automation_run_read", { runId }, false).pipe(
        Effect.flatMap(decodeRead),
        Effect.map((read) => ({ status: read.run.status, output: read.output })),
      ),
    ),
  cancel: (runId) =>
    Effect.runPromise(ask("automation_cancel_run", { runId }, false).pipe(Effect.asVoid)),
});

/** What the "Payment" built-in returns (`defaults/payment.ts`). */
type PaymentOutcome = "done" | "failed";

/** How a payment went, as `needs_you_payment` answers it. */
export type PaymentAnswer =
  | { readonly status: "waiting"; readonly tabId: string; readonly message: string }
  | {
      readonly status: PaymentOutcome;
      readonly tabId: string;
      /** What the person told the agent, if anything. */
      readonly note: string | null;
      readonly message: string;
    };

type Finished = Extract<PaymentAnswer, { readonly status: PaymentOutcome }>;

const failed = (tabId: string, why: string): Finished => ({
  status: "failed",
  tabId,
  note: null,
  message: `${why} ${NOT_PAID}`,
});

/** The run's answer: the built-in returns `{ outcome, note }`; anything else didn't pay. */
const finishedOf = (
  tabId: string,
  run: { readonly status: AutomationRunStatus; readonly output: unknown },
): Finished => {
  if (run.status === "cancelled") return failed(tabId, "Someone withdrew the payment request.");
  if (run.status !== "succeeded") return failed(tabId, "The payment request failed.");
  const output = (run.output ?? {}) as { readonly outcome?: unknown; readonly note?: unknown };
  const note = typeof output.note === "string" && output.note.trim() ? output.note : null;
  return output.outcome === "done"
    ? { status: "done", tabId, note, message: PAID }
    : { status: "failed", tabId, note, message: NOT_PAID };
};

const failure = (text: string) =>
  new ServerBrowserPage.ServerBrowserOperationError("PreviewAutomationExecutionError", text);

const hostOf = (url: string) => parse(url)?.hostname ?? url;

export interface PaymentRequest {
  readonly tabId?: string | undefined;
  readonly note?: string | undefined;
  readonly savedToAccount?: boolean | undefined;
}

export interface Payments {
  /** The browser's guard: hands a payment page over before the agent acts on it. */
  readonly guard: PageGuard;
  readonly bind: (browser: BrowserBackend) => void;
  /** `needs_you_payment`: hands the tab over once, then waits up to `AGENT_WAIT_MS` for the outcome. */
  readonly request: (input: PaymentRequest) => Promise<PaymentAnswer>;
  /** Withdraws every open payment request: the browser is going away. */
  readonly close: () => Promise<void>;
}

/** One tab's payment: the person is asked, or answered. */
type TabPayment =
  | {
      readonly state: "asking";
      readonly runId: Promise<string>;
      readonly outcome: Promise<Finished>;
      /** Ends it with `answer`, giving the tab back to the agent. */
      readonly end: (answer: Finished) => void;
      /** A call waits on it: read the run often. */
      readonly hurry: () => () => void;
    }
  | {
      readonly state: "answered";
      readonly answer: Finished;
      /** A call already told the agent. */
      delivered: boolean;
    };

export const makePayments = (options: {
  readonly asker: PaymentAsker;
  readonly timer?: Timer;
  readonly kind?: (page: Page, options: { readonly after?: boolean }) => Promise<PageKind>;
}): Payments => {
  const timer = options.timer ?? defaultTimer;
  const kindOf = options.kind ?? pageKind;
  let browser: BrowserBackend | null = null;
  const payments = new Map<string, TabPayment>();

  const bound = () => {
    if (browser?.pageOf === undefined || browser.handOff === undefined)
      throw failure("This browser can't hand tabs to the person.");
    return { pageOf: browser.pageOf, handOff: browser.handOff };
  };

  /** Hands `tabId` to the person and asks them, once per payment. */
  const raise = (tabId: string, page: Page, input: PaymentRequest) => {
    const existing = payments.get(tabId);
    if (existing?.state === "asking") return existing;
    const { handOff } = bound();
    const url = page.url();
    const handoff: AgentBrowserHandoff = {
      kind: "payment",
      site: hostOf(url),
      runId: null,
      ownBrowserUrl: input.savedToAccount === true ? url : null,
    };
    // Held before the person is even asked, so the agent can't act on it meanwhile.
    handOff(tabId, handoff);
    let settle: (answer: Finished) => void = () => {};
    const outcome = new Promise<Finished>((resolve) => {
      settle = resolve;
    });
    let ended = false;
    let waiters = 0;
    let cancelPoll = () => {};
    let cancelPatience = () => {};
    const runId = options.asker.start(tabId, {
      site: handoff.site,
      note: input.note?.trim() || null,
      ownBrowserUrl: handoff.ownBrowserUrl,
    });

    const end = (answer: Finished | null) => {
      if (ended) return;
      ended = true;
      cancelPoll();
      cancelPatience();
      handOff(tabId, null);
      if (payments.get(tabId) === entry)
        if (answer === null) payments.delete(tabId);
        else payments.set(tabId, { state: "answered", answer, delivered: false });
      if (answer !== null) settle(answer);
    };
    /** Reads the run again after a while, sooner while a call waits on it. */
    const poll = (id: string) => {
      if (ended) return;
      cancelPoll();
      cancelPoll = timer(
        () => {
          options.asker.read(id).then(
            (run) => (run.status === "running" ? poll(id) : end(finishedOf(tabId, run))),
            // The cloud didn't answer this time; it's read again.
            () => poll(id),
          );
        },
        waiters > 0 ? PAYMENT_POLL_MS : PAYMENT_IDLE_POLL_MS,
      );
    };
    let pollId: string | null = null;
    const entry: Extract<TabPayment, { readonly state: "asking" }> = {
      state: "asking",
      runId,
      outcome,
      end,
      hurry: () => {
        waiters += 1;
        if (pollId !== null) poll(pollId);
        return () => {
          waiters -= 1;
        };
      },
    };
    payments.set(tabId, entry);
    void runId.then(
      (id) => {
        if (ended) return;
        pollId = id;
        handOff(tabId, { ...handoff, runId: id });
        poll(id);
        cancelPatience = timer(() => {
          void options.asker.cancel(id).catch(() => undefined);
          end(failed(tabId, `Nobody answered for ${minutes(PAYMENT_PATIENCE_MS)}.`));
        }, PAYMENT_PATIENCE_MS);
      },
      // Nobody was asked: the tab is the agent's again, and the caller hears why.
      () => end(null),
    );
    return entry;
  };

  /** Rejects the way the agent should hear it when nobody could be asked. */
  const asked = (entry: { readonly runId: Promise<string> }) =>
    entry.runId.catch((cause: unknown) => {
      throw failure(
        `Signalbox couldn't ask the person to pay (${cause instanceof Error ? cause.message : String(cause)}). Stop here and tell them in your reply.`,
      );
    });

  return {
    guard: async ({ tabId, page, after }) => {
      const current = payments.get(tabId);
      // An action that got past the hold while it began never reaches the page.
      if (current?.state === "asking") throw failure(REACHED_PAYMENT);
      if ((await kindOf(page, { after })) !== "payment") return;
      if (current?.state === "answered") throw failure(ALREADY_ANSWERED);
      await asked(raise(tabId, page, {}));
      throw failure(REACHED_PAYMENT);
    },
    bind: (next) => {
      browser = next;
    },
    request: async (input) => {
      const known = input.tabId === undefined ? undefined : payments.get(input.tabId);
      // A tab with a payment needs no page: it may be closed or resting.
      const { tabId, page } =
        known === undefined
          ? await bound().pageOf(input.tabId === undefined ? {} : { tabId: input.tabId })
          : { tabId: input.tabId!, page: null };
      const current = payments.get(tabId);
      if (current?.state === "answered" && !current.delivered) {
        current.delivered = true;
        return current.answer;
      }
      let entry: Extract<TabPayment, { readonly state: "asking" }>;
      if (current?.state === "asking") entry = current;
      else {
        const shown = page ?? (await bound().pageOf({ tabId })).page;
        const kind = await kindOf(shown, {});
        if (kind === "sign-in" || kind === "captcha") throw failure(NOT_A_PAYMENT);
        entry = raise(tabId, shown, input);
      }
      await asked(entry);
      const done = entry.hurry();
      let cancel = () => {};
      const answer = await Promise.race([
        entry.outcome,
        new Promise<null>((resolve) => {
          cancel = timer(() => resolve(null), AGENT_WAIT_MS);
        }),
      ]).finally(() => {
        cancel();
        done();
      });
      if (answer === null) return { status: "waiting", tabId, message: STILL_WAITING };
      const answered = payments.get(tabId);
      if (answered?.state === "answered") answered.delivered = true;
      return answer;
    },
    close: async () => {
      const asking = [...payments].flatMap(([tabId, each]) =>
        each.state === "asking" ? [{ tabId, each }] : [],
      );
      for (const { tabId, each } of asking) each.end(failed(tabId, "The browser closed."));
      payments.clear();
      await Promise.all(
        asking.map(({ each }) =>
          each.runId.then((id) => options.asker.cancel(id)).catch(() => undefined),
        ),
      );
    },
  };
};

/** `needs_you_payment`, beside the `preview_*` tools. */
export const layerPaymentTool = (payments: Payments) =>
  Layer.effectDiscard(
    register({
      name: "needs_you_payment",
      description: `Hand a payment to the person. Call it right before anything that pays, places an order or confirms a card (3-D Secure), on the tab where that happens; a page with card fields or a 3-D Secure check is handed over by itself. They finish it in your browser and answer Done or Failed, and you can't read or act on that tab meanwhile. This waits up to ${AGENT_WAIT_MS / 1000} seconds: while it answers waiting, call it again and keep your turn going. Sign-ins, codes and CAPTCHAs never go to the person this way.`,
      parameters: Schema.Struct({
        tabId: Schema.optional(
          Schema.String.annotate({
            description: "The tab with the payment. Omit for the current tab.",
          }),
        ),
        note: Schema.optional(
          Schema.String.annotate({
            description: "What they're paying for and how much, as the person should read it.",
          }),
        ),
        savedToAccount: Schema.optional(
          Schema.Boolean.annotate({
            description:
              "True when the cart or order lives in their account, so they can also finish it in their own browser.",
          }),
        ),
      }),
      handle: (input) => answer(() => payments.request(input)),
      writes: { destructive: true, openWorld: true },
    }),
  );
