import { codeModeAudio, codeModeImage, generatedCodeModeImage } from "./media.ts";
import { CodeModeQueue } from "./queue.ts";
import { CodeModeTimers } from "./timers.ts";
import type { CodeModeCellInvocation, CodeModeContent, Json } from "./types.ts";

const EXIT_SENTINEL = "__codex_code_mode_exit__";

export function installCodeModeGlobals(input: CodeModeCellInvocation) {
  const decodeBase64 = globalThis.atob.bind(globalThis);
  const queue = new CodeModeQueue();
  const timers = new CodeModeTimers(queue);
  const values = new Map(Object.entries(input.storedValues));
  const writes = new Map<string, Json>();
  const pendingTools = new Map<string, ReturnType<typeof Promise.withResolvers<Json>>>();
  let active = true;
  let exited = false;
  let nextTool = 1;

  const send = (item: CodeModeContent | "yield") => {
    if (!active) throw EXIT_SENTINEL;
    queue.push({
      kind: "output",
      event: item === "yield" ? { type: "yield" } : { type: "content", item },
    });
  };
  const json = (value: unknown): Json | undefined => {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized);
  };
  const serializeText = (value: unknown): string => {
    if (
      value === null ||
      ["undefined", "string", "number", "boolean", "bigint"].includes(typeof value)
    )
      return String(value);
    return JSON.stringify(value) ?? String(value);
  };
  const tools = Object.fromEntries(
    input.request.enabled_tools.map((tool, index) => [
      tool.name,
      (value?: unknown) => {
        if (!active) throw EXIT_SENTINEL;
        const argument = json(value);
        const id = `tool-${nextTool++}`;
        // This promise must originate at the guest call site, not in the request-owned pump.
        const result = Promise.withResolvers<Json>();
        pendingTools.set(id, result);
        queue.push({ kind: "tool", index, argument, id });
        const returned = result.promise.finally(() => pendingTools.delete(id));
        void returned.catch(() => undefined);
        return returned;
      },
    ]),
  );
  Object.assign(globalThis, {
    tools,
    ALL_TOOLS: input.request.enabled_tools.map(({ name, description }) => ({ name, description })),
    text: (value?: unknown) => send({ type: "input_text", text: serializeText(value) }),
    image: (value: unknown, detail?: unknown) => send(codeModeImage(value, detail)),
    audio: (value: unknown) => send(codeModeAudio(value, decodeBase64)),
    generatedImage: (value: unknown) => {
      for (const item of generatedCodeModeImage(value)) send(item);
    },
    store: (key: unknown, value: unknown) => {
      if (!active) throw EXIT_SENTINEL;
      const name = String(key);
      const serialized = json(value);
      if (serialized === undefined)
        throw `Unable to store ${JSON.stringify(name)}. Only plain serializable objects can be stored.`;
      values.set(name, serialized);
      writes.set(name, serialized);
    },
    load: (key: unknown) => {
      const value = values.get(String(key));
      return value === undefined ? undefined : json(value);
    },
    notify: (value: unknown) => {
      if (!active) throw EXIT_SENTINEL;
      const text = serializeText(value);
      if (text.trim().length === 0) throw "notify expects non-empty text";
      queue.push({ kind: "notify", text });
    },
    yield_control: () => send("yield"),
    exit: () => {
      exited = true;
      throw EXIT_SENTINEL;
    },
    setTimeout: (callback: unknown, delay?: unknown) => {
      if (!active) throw EXIT_SENTINEL;
      return timers.set(callback, delay);
    },
    clearTimeout: (value: unknown) => timers.clear(value),
  });
  return {
    queue,
    timers,
    isExit: (error: unknown) => exited && error === EXIT_SENTINEL,
    writes: () => Object.fromEntries(writes),
    settleTool(id: string, result: { value: Json } | { error: string }) {
      if (!active) return;
      const waiter = pendingTools.get(id);
      if ("value" in result) waiter?.resolve(result.value);
      else waiter?.reject(result.error);
    },
    revokeGuest() {
      active = false;
      // Host-owned tool promises can unwind. Arbitrary guest timer promises cannot.
      for (const waiter of pendingTools.values()) waiter.reject(EXIT_SENTINEL);
      pendingTools.clear();
      timers.revoke();
    },
  };
}

export type CodeModeGlobals = ReturnType<typeof installCodeModeGlobals>;
