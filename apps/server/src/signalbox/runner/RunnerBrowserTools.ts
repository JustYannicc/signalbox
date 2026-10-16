import {
  PreviewAutomationClickInput,
  PreviewAutomationDialogInput,
  PreviewAutomationDragInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationHoverInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationResizeInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSelectInput,
  PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationSnapshot,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationUploadInput,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import type { BrowserSignInAnswer } from "@signalbox/runner-protocol/BrowserProtocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { McpSchema } from "effect/ai";

import type { BrowserBackend } from "./RunnerBrowser.ts";
import { json, register, ToolError } from "./RunnerContextTools.ts";

/**
 * The `preview_*` tools (#402) for agents on a thread's machine, by the names
 * and argument contracts agents use locally (`mcp/toolkits/preview/tools.ts`),
 * so the work log shows them the same way. They run on `BrowserBackend`;
 * which browser that is never reaches the agent. `sign_in` (#576) is
 * Signalbox's own: one call signs the person's browser in from 1Password,
 * and its answer, a status, is the sign-in's line in the thread's trail.
 */

/** Served under upstream's MCP name, so tool names match local threads exactly. */
export const BROWSER_SERVER_NAME = "t3-code";

export const BROWSER_INSTRUCTIONS = [
  "The preview_* tools open each URL in the right browser for it. Your own work (localhost, this machine's ports and network) opens in a headless browser here, with no logins or cookies: start the dev server in the background, then open it at http://localhost:<port> (or preview_navigate with target {kind:'environment-port',port}).",
  "Real sites open in the person's own cloud browser, signed in as them with the logins they have saved there. Act there as they would, and stop to ask before anything they'd want to decide: sending, deleting, accepting terms. Payments go to the person to finish: call needs_you_payment right before paying, and keep calling it until they answer. If a site asks you to sign in, call sign_in: it signs the person's browser in with their saved 1Password login, which you never see, and their tabs reload signed in. Never type a password or code yourself. When sign_in can't, do what its message says, and never retry a failed one. A tab moves between the two browsers when its URL does, so dev tabs never carry the person's cookies.",
  "preview_snapshot returns the page's text, accessibility tree, console and network entries. To show the user a screenshot, call preview_snapshot with save=true: it appears in this thread with the tool call. Files on this machine can't be embedded in your reply.",
].join("\n");

/** Console and network entries a snapshot reports, newest last, as upstream's snapshots do. */
const SNAPSHOT_ENTRY_LIMIT = 40;
/** Characters of each text a snapshot reports, so one page can't flood the agent's context. */
const SNAPSHOT_TEXT_LIMITS = { visibleText: 8_000, accessibilityTree: 12_000, entry: 500 };

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`;

const run = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new ToolError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });

/** The tool's answer: the operation's result as JSON, or its error for the agent. */
export const answer = <A>(operation: () => Promise<A>) =>
  Effect.map(run(operation), (result) => json(result ?? { ok: true }));

/**
 * A snapshot as the agent reads it. The screenshot rides along as an image
 * only when asked: providers replay images on every later request.
 */
const presentSnapshot = (
  snapshot: PreviewAutomationSnapshot,
  options: { readonly includeImage: boolean; readonly save: boolean },
): ReadonlyArray<McpSchema.ContentBlock> => {
  const { screenshot, ...page } = snapshot;
  const image: McpSchema.ContentBlock = {
    type: "image",
    data: Buffer.from(screenshot.data, "base64"),
    mimeType: screenshot.mimeType,
  };
  if (options.save && !options.includeImage)
    return [{ type: "text", text: json({ url: page.url, savedToThread: true }) }, image];
  const metadata = {
    ...page,
    visibleText: cut(page.visibleText, SNAPSHOT_TEXT_LIMITS.visibleText),
    accessibilityTree:
      typeof page.accessibilityTree === "string"
        ? cut(page.accessibilityTree, SNAPSHOT_TEXT_LIMITS.accessibilityTree)
        : page.accessibilityTree,
    consoleEntries: page.consoleEntries
      .slice(-SNAPSHOT_ENTRY_LIMIT)
      .map((entry) => ({ ...entry, text: cut(entry.text, SNAPSHOT_TEXT_LIMITS.entry) })),
    networkEntries: page.networkEntries
      .slice(-SNAPSHOT_ENTRY_LIMIT)
      .map((entry) => ({ ...entry, url: cut(entry.url, SNAPSHOT_TEXT_LIMITS.entry) })),
    screenshot: {
      mimeType: screenshot.mimeType,
      width: screenshot.width,
      height: screenshot.height,
    },
  };
  return [
    { type: "text", text: json(metadata) },
    ...(options.includeImage || options.save ? [image] : []),
  ];
};

/** A sign-in as the agent reads it: how it went, and the login by name only. */
const presentSignIn = (answer: BrowserSignInAnswer) =>
  json(
    answer._tag === "signed_in"
      ? {
          status: answer._tag,
          site: answer.site,
          login: answer.item,
          username: answer.username,
          message: `Signed in to ${answer.site}${answer.username === null ? "" : ` as ${answer.username}`} from 1Password: ${answer.item}. The person's tabs reloaded signed in.`,
        }
      : { status: answer._tag, site: answer.site, message: answer.message },
  );

const acts = { destructive: true, openWorld: true } as const;
const moves = { destructive: false, openWorld: true } as const;

/** Every `preview_*` tool, on `browser`. */
export const layerBrowserTools = (browser: BrowserBackend) =>
  Layer.effectDiscard(
    Effect.all([
      register({
        name: "preview_status",
        description:
          "Report the browser's current tab: its URL, title, pending dialog and viewport, plus every open tab (tabs). Pass tabId to read a specific tab.",
        parameters: PreviewAutomationTabTargetInput,
        handle: (input) => answer(() => browser.status(input)),
      }),
      register({
        name: "preview_open",
        description:
          "Open a browser tab, optionally at url, and make it the current tab. Omit tabId to reuse the current tab; set reuseExistingTab=false for another one. Pass the returned tabId when you work in several tabs.",
        parameters: PreviewAutomationOpenInput,
        handle: (input) => answer(() => browser.open(input)),
        writes: moves,
      }),
      register({
        name: "preview_navigate",
        description:
          "Navigate a tab. Pass {url:'http://localhost:5173'} or {target:{kind:'environment-port',port:5173}} for a dev server on this machine. Exactly one of url or target is required.",
        parameters: PreviewAutomationNavigateInput,
        handle: (input) => answer(() => browser.navigate(input)),
        writes: moves,
      }),
      register({
        name: "preview_dialog",
        description:
          "Accept or dismiss the dialog preview_status reports. For a prompt, supply promptText when accepting.",
        parameters: PreviewAutomationDialogInput,
        handle: (input) => answer(() => browser.dialog(input)),
        writes: acts,
      }),
      register({
        name: "preview_resize",
        description:
          "Resize a tab's viewport: {mode:'freeform',width:1024,height:768}, {mode:'preset',preset:'iphone-12-pro'}, or {mode:'fill'} for the default 1280x800.",
        parameters: PreviewAutomationResizeInput,
        handle: (input) => answer(() => browser.resize(input)),
        writes: moves,
      }),
      register({
        name: "preview_set_appearance",
        description:
          "Emulate prefers-color-scheme in a tab: {colorScheme:'dark'} or {colorScheme:'light'}, or 'system' to clear the override.",
        parameters: PreviewAutomationSetColorSchemeInput,
        handle: (input) => answer(() => browser.setColorScheme(input)),
        writes: moves,
      }),
      register({
        name: "preview_snapshot",
        description:
          "Inspect a page before interacting: its text, accessibility tree with refs, console and network entries, and action history. Pass locator=aria-ref=<ref> to target one element; take a fresh snapshot after navigating. Set includeImage=true only when you need to see the page. Set save=true to show the user the screenshot: it appears in this thread with this tool call.",
        parameters: Schema.Struct({
          ...PreviewAutomationTabTargetInput.fields,
          includeImage: Schema.optional(Schema.Boolean),
          save: Schema.optional(Schema.Boolean),
        }),
        handle: ({ includeImage, save, ...input }) =>
          Effect.map(
            run(() => browser.snapshot(input)),
            (snapshot) =>
              presentSnapshot(snapshot, {
                includeImage: includeImage === true,
                save: save === true,
              }),
          ),
      }),
      register({
        name: "preview_click",
        description:
          "Click exactly one target. Prefer a Playwright locator; selector accepts legacy CSS; x and y must be supplied together. Set button=right for a context menu or clickCount=2 for a double-click.",
        parameters: PreviewAutomationClickInput,
        handle: (input) => answer(() => browser.click(input)),
        writes: acts,
      }),
      register({
        name: "preview_type",
        description:
          "Insert literal text into one input. Prefer a Playwright locator; set clear=true to replace existing text.",
        parameters: PreviewAutomationTypeInput,
        handle: (input) => answer(() => browser.type(input)),
        writes: acts,
      }),
      register({
        name: "preview_hover",
        description: "Move the mouse over exactly one target to reveal hover menus and tooltips.",
        parameters: PreviewAutomationHoverInput,
        handle: (input) => answer(() => browser.hover(input)),
        writes: moves,
      }),
      register({
        name: "preview_select",
        description:
          "Choose options in one native <select>, by value or visible label. Custom dropdowns are not <select>: click them open, then click the option.",
        parameters: PreviewAutomationSelectInput,
        handle: (input) => answer(() => browser.select(input)),
        writes: acts,
      }),
      register({
        name: "preview_drag",
        description: "Drag one element onto another.",
        parameters: PreviewAutomationDragInput,
        handle: (input) => answer(() => browser.drag(input)),
        writes: acts,
      }),
      register({
        name: "preview_upload",
        description:
          "Set files on this machine, by absolute path, on the <input type=file> the locator names.",
        parameters: PreviewAutomationUploadInput,
        handle: (input) => answer(() => browser.upload(input)),
        writes: acts,
      }),
      register({
        name: "preview_press",
        description:
          "Press one keyboard key. Examples: {key:'Enter'}, {key:'Escape'}, or {key:'a',modifiers:['Control']}.",
        parameters: PreviewAutomationPressInput,
        handle: (input) => answer(() => browser.press(input)),
        writes: acts,
      }),
      register({
        name: "preview_scroll",
        description:
          "Scroll a tab. Positive deltaY scrolls down and positive deltaX scrolls right; a locator/selector targets a container.",
        parameters: PreviewAutomationScrollInput,
        handle: (input) => answer(() => browser.scroll(input)),
        writes: moves,
      }),
      register({
        name: "preview_evaluate",
        description:
          "Evaluate JavaScript in a tab. Returns {value} with a serializable result up to 64 KB; the expression may change the page.",
        parameters: PreviewAutomationEvaluateInput,
        handle: (input) =>
          Effect.map(
            run(() => browser.evaluate(input)),
            (value) => json({ value: value ?? null }),
          ),
        writes: acts,
      }),
      register({
        name: "sign_in",
        description:
          "Sign the person's browser in to a site with their saved 1Password login, which you never see. Call it when a page asks you to sign in; site defaults to the current tab's. It answers only how it went: signed_in (the tabs reload signed in), no_saved_login, not_allowed (ask the person what it says) or failed (tell the person; don't retry).",
        parameters: Schema.Struct({
          site: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
        }),
        handle: ({ site }) =>
          Effect.map(
            run(() => browser.signIn(site === undefined ? {} : { site })),
            presentSignIn,
          ),
        writes: acts,
      }),
      register({
        name: "preview_wait_for",
        description:
          "Wait in a tab until all supplied locator, selector, text, and URL conditions match.",
        parameters: PreviewAutomationWaitForInput,
        handle: (input) => answer(() => browser.waitFor(input)),
      }),
    ]),
  );
