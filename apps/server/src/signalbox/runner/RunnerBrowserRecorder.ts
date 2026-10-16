// @effect-diagnostics nodeBuiltinImport:off - reads rrweb's recorder from disk, as Playwright is loaded.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type { CDPSession, Page } from "playwright-core";

/**
 * rrweb's recorder in a tab of the agent's browser (#587): what the mirror
 * replays and the trail keeps. The recorder runs in the page's main world in
 * every frame; only the top frame reports, and cross-origin frames post to it
 * (`recordCrossOriginIframes`). It reports over a CDP binding on the tab's own
 * session, under a random name the script takes and deletes before the page's
 * own scripts run, so a site sees no automation global (Playwright's
 * `exposeBinding` would leave `__playwright__binding__` behind).
 *
 * Events leave the page in ~100 ms batches. A batch never carries a full
 * snapshot after other events, so one starting with rrweb's `Meta` is where a
 * replay can start (`full`).
 *
 * Canvases record only on `recordCanvas(page, true)`: the top frame restarts
 * its recording with canvas sampling, which begins with a full snapshot. A new
 * document starts without, and each full batch says which way it records, so
 * the mirror turns it back on. Cross-origin frames never record canvases;
 * their recorders can't be reached from the top frame.
 */

/** A batch of rrweb events, or the mark `markStep` left between two steps. */
export type RecorderReport =
  | {
      readonly _tag: "events";
      /** Starts with a full snapshot. */
      readonly full: boolean;
      /** The page was asked to record canvases (it may fall back to recording without). */
      readonly canvas: boolean;
      /** A JSON array. */
      readonly events: string;
      readonly url: string;
      readonly title: string;
    }
  | { readonly _tag: "step"; readonly stepId: string };

const BATCH_MS = 100;
/** Characters a page sends after a full snapshot before it takes a fresh one. */
export const RECORDING_CHECKOUT_CHARS = 8_000_000;
const STATE_KEY = "signalbox.mirror";

// rrweb's IIFE build ships as a file; createRequire also resolves it beside the bundled Runner.
const requireRecorder = NodeModule.createRequire(import.meta.url);
let recorderSource: string | null | undefined;

/** rrweb's recorder, read once; null when this install has none. */
const readRecorder = (): string | null => {
  if (recorderSource !== undefined) return recorderSource;
  try {
    const dist = NodePath.dirname(requireRecorder.resolve("@rrweb/record"));
    recorderSource = NodeFS.readFileSync(NodePath.join(dist, "record.umd.min.cjs"), "utf8")
      .replace(/\/\/# sourceMappingURL=\S+\s*$/, "")
      .concat("\n");
  } catch {
    recorderSource = null;
  }
  return recorderSource;
};

/**
 * The script every frame of a tab runs; `binding` names this tab's CDP
 * binding. Inputs record every keystroke, not rrweb's `input: "last"`, which
 * records only `change` events: a person typing through the mirror sees each
 * key land.
 */
const pageScript = (recorder: string, binding: string) => `(() => {
  const send = globalThis[${JSON.stringify(binding)}];
  try { delete globalThis[${JSON.stringify(binding)}]; } catch {}
  const top = window.top === window;
  if (top && typeof send !== "function") return;
  const key = Symbol.for(${JSON.stringify(STATE_KEY)});
  // Reconnecting to the person's browser injects again into the same document.
  if (top) globalThis[key]?.stop();
  const holder = {};
  (function (define, exports, module) {
${recorder}}).call(holder);
  const record = holder.rrwebRecord && holder.rrwebRecord.record;
  if (typeof record !== "function") return;
  const stringify = JSON.stringify;
  const setTimer = setTimeout;
  const clearTimer = clearTimeout;
  let pending = [];
  let timer = 0;
  let chars = 0;
  let stopped = false;
  const flush = (checkout) => {
    if (timer) clearTimer(timer);
    timer = 0;
    if (stopped || pending.length === 0) return;
    const full = pending[0].type === 4;
    const events = stringify(pending);
    pending = [];
    chars = full ? events.length : chars + events.length;
    send(stringify({ full, canvas, url: location.href, title: document.title }) + "\\n" + events);
    if (checkout && chars > ${RECORDING_CHECKOUT_CHARS}) {
      chars = 0;
      try { record.takeFullSnapshot(); } catch {}
    }
  };
  const emit = (event) => {
    if (stopped) return;
    if (event.type === 4) flush(false);
    pending.push(event);
    if (!timer) timer = setTimer(() => flush(true), ${BATCH_MS});
  };
  const options = {
    emit,
    recordAfter: "DOMContentLoaded",
    recordCrossOriginIframes: true,
    inlineStylesheet: true,
    maskInputOptions: { password: true },
    sampling: { scroll: 150, mousemove: false },
  };
  let canvas = false;
  let stopRecording;
  const start = () => {
    stopRecording = undefined;
    if (canvas)
      try {
        stopRecording = record({
          ...options,
          recordCanvas: true,
          sampling: { ...options.sampling, canvas: 1 },
          dataURLOptions: { type: "image/webp", quality: 0.6 },
        });
      } catch {}
    if (!stopRecording) stopRecording = record(options);
  };
  start();
  if (!top) return;
  addEventListener("pagehide", () => flush(false));
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: {
      stop: () => {
        stopped = true;
        if (timer) clearTimer(timer);
        try { stopRecording && stopRecording(); } catch {}
        delete globalThis[key];
      },
      canvas: (on) => {
        if (stopped || on === canvas) return;
        canvas = on;
        try { stopRecording && stopRecording(); } catch {}
        start();
      },
      step: (stepId) => {
        flush(false);
        send(stringify({ step: stepId }));
        try { record.takeFullSnapshot(); } catch {}
        flush(false);
        return true;
      },
    },
  });
})();`;

/** Reads what the page sent; null for anything else. */
export const readReport = (payload: string): RecorderReport | null => {
  try {
    const split = payload.indexOf("\n");
    const head: unknown = JSON.parse(split === -1 ? payload : payload.slice(0, split));
    if (typeof head !== "object" || head === null) return null;
    const fields = head as Record<string, unknown>;
    if (split === -1)
      return typeof fields.step === "string" ? { _tag: "step", stepId: fields.step } : null;
    const events = payload.slice(split + 1);
    if (!events.startsWith("[")) return null;
    return {
      _tag: "events",
      full: fields.full === true,
      canvas: fields.canvas === true,
      events,
      url: typeof fields.url === "string" ? fields.url : "",
      title: typeof fields.title === "string" ? fields.title : "",
    };
  } catch {
    return null;
  }
};

/**
 * Records `page` from its next document on, and its current one now, into
 * `report`. False when this install has no recorder.
 */
export const injectRecorder = async (
  page: Page,
  cdp: CDPSession,
  report: (payload: string) => void,
): Promise<boolean> => {
  const recorder = readRecorder();
  if (recorder === null) return false;
  const binding = `__${NodeCrypto.randomBytes(6).toString("hex")}`;
  cdp.on("Runtime.bindingCalled", (event) => {
    if (event.name === binding) report(event.payload);
  });
  // Chromium installs a session's bindings only while its Runtime domain is on.
  await cdp.send("Runtime.enable");
  await cdp.send("Runtime.addBinding", { name: binding });
  const script = pageScript(recorder, binding);
  await page.addInitScript({ content: script });
  // The document already open; a page still loading records from its next one.
  await page.evaluate(script).catch(() => undefined);
  return true;
};

/**
 * Ends the page's current step: what it sent so far, then a `step` report,
 * then a fresh full snapshot. False when the page records nothing.
 */
export const markStep = (page: Page, stepId: string): Promise<boolean> =>
  page.evaluate(
    ([key, id]) => {
      const state = (globalThis as Record<symbol, { step?: (id: string) => boolean } | undefined>)[
        Symbol.for(key)
      ];
      return state?.step?.(id) === true;
    },
    [STATE_KEY, stepId] as const,
  );

/** Has the page record its canvases, or stop; a page that records nothing ignores it. */
export const recordCanvas = (page: Page, on: boolean): Promise<void> =>
  page
    .evaluate(
      ([key, value]) => {
        const state = (
          globalThis as Record<symbol, { canvas?: (on: boolean) => void } | undefined>
        )[Symbol.for(key)];
        state?.canvas?.(value);
      },
      [STATE_KEY, on] as const,
    )
    .catch(() => undefined);
