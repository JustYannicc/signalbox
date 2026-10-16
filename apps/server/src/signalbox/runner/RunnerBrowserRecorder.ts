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
 * `exposeBinding` would leave `__playwright__binding__` behind). What the
 * runner asks of the recorder (end a step, record canvases, find an element
 * by rrweb id) lives on one non-enumerable property of the top window, under
 * the tab's own random name (`recorderKey`): nothing names it after us.
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

/**
 * A name for a tab's recorder in its pages. Keep one per tab: a reconnect
 * injects again into the same document, and stops the recorder already there
 * by this name.
 */
export const recorderKey = (): string => `__${NodeCrypto.randomBytes(6).toString("hex")}`;

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
const pageScript = (recorder: string, binding: string, key: string) => `(() => {
  const send = globalThis[${JSON.stringify(binding)}];
  try { delete globalThis[${JSON.stringify(binding)}]; } catch {}
  const top = window.top === window;
  if (top && typeof send !== "function") return;
  const key = ${JSON.stringify(key)};
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
      // Where rrweb's element with this id is in the top window's viewport now, through
      // the same-origin frames it sits in; null when it's gone or has no box.
      box: (id) => {
        let node = record.mirror && record.mirror.getNode(id);
        if (node && node.nodeType !== 1) node = node.parentElement;
        if (!node || !node.isConnected || typeof node.getBoundingClientRect !== "function") return null;
        const rect = node.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return null;
        let x = rect.left;
        let y = rect.top;
        let view = node.ownerDocument.defaultView;
        while (view && view !== window) {
          const frame = view.frameElement;
          if (!frame) return null;
          const at = frame.getBoundingClientRect();
          x += at.left + frame.clientLeft;
          y += at.top + frame.clientTop;
          view = frame.ownerDocument.defaultView;
        }
        return { left: x, top: y, width: rect.width, height: rect.height, viewWidth: innerWidth, viewHeight: innerHeight };
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
  key: string,
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
  const script = pageScript(recorder, binding, key);
  await page.addInitScript({ content: script });
  // The document already open; a page still loading records from its next one.
  await page.evaluate(script).catch(() => undefined);
  return true;
};

/**
 * Ends the page's current step: what it sent so far, then a `step` report,
 * then a fresh full snapshot. False when the page records nothing.
 */
export const markStep = (page: Page, key: string, stepId: string): Promise<boolean> =>
  page.evaluate(
    ([name, id]) => {
      const state = (globalThis as Record<string, { step?: (id: string) => boolean } | undefined>)[
        name
      ];
      return state?.step?.(id) === true;
    },
    [key, stepId] as const,
  );

/** Has the page record its canvases, or stop; a page that records nothing ignores it. */
export const recordCanvas = (page: Page, key: string, on: boolean): Promise<void> =>
  page
    .evaluate(
      ([name, value]) => {
        const state = (
          globalThis as Record<string, { canvas?: (on: boolean) => void } | undefined>
        )[name];
        state?.canvas?.(value);
      },
      [key, on] as const,
    )
    .catch(() => undefined);

/** An element's box in the top window's viewport, and that viewport's size, in CSS pixels. */
export interface NodeBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly viewWidth: number;
  readonly viewHeight: number;
}

const isNodeBox = (value: unknown): value is NodeBox =>
  typeof value === "object" &&
  value !== null &&
  ["left", "top", "width", "height", "viewWidth", "viewHeight"].every((field) =>
    Number.isFinite((value as Record<string, unknown>)[field]),
  );

/**
 * Where rrweb's element `node` is in the tab's page now, asked over the tab's
 * CDP session (no Playwright utility world, so nothing more shows in the
 * page); null when the page records nothing or has no such element.
 */
export const nodeBox = async (
  cdp: CDPSession,
  key: string,
  node: number,
): Promise<NodeBox | null> => {
  if (!Number.isSafeInteger(node)) return null;
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => { const state = globalThis[${JSON.stringify(key)}]; return state && typeof state.box === "function" ? state.box(${node}) : null; })()`,
    returnByValue: true,
    silent: true,
  });
  const value: unknown = result.exceptionDetails ? null : result.result.value;
  return isNodeBox(value) ? value : null;
};
