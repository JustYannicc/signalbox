import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Node compatibility requires the native stream and process interfaces.
import * as NodeStream from "node:stream";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Node compatibility requires the native stream and process interfaces.
import type * as NodeStreamWeb from "node:stream/web";
import type { SdkSpawnedProcess } from "../claude/SdkTypes.ts";
import type { NodeHarnessProcess } from "../NodeHarnessProcess.ts";

export function createSdkProcess(
  process: NodeHarnessProcess,
  stderr: (text: string) => void,
): SdkSpawnedProcess {
  const events = new NodeEvents.EventEmitter();
  const stdin = NodeStream.Writable.fromWeb(
    process.stdin as NodeStreamWeb.WritableStream<Uint8Array>,
  );
  const stdout = NodeStream.Readable.fromWeb(
    process.stdout as NodeStreamWeb.ReadableStream<Uint8Array>,
  );
  const errors = NodeStream.Readable.fromWeb(
    process.stderr as NodeStreamWeb.ReadableStream<Uint8Array>,
  );
  const decoder = new TextDecoder();
  errors.on("data", (bytes: Uint8Array) => stderr(decoder.decode(bytes, { stream: true })));
  errors.once("end", () => {
    const tail = decoder.decode();
    if (tail) stderr(tail);
  });
  errors.on("error", (error: Error) => events.emit("error", error));
  let killed = false;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  void process.exited.then(
    (status) => {
      exitCode = status.signal === 0 ? status.exitCode : null;
      signalCode = status.signal === 0 ? null : status.signal === 9 ? "SIGKILL" : "SIGTERM";
      events.emit("exit", exitCode, signalCode);
    },
    (cause: unknown) =>
      events.emit("error", cause instanceof Error ? cause : new Error(String(cause))),
  );
  return {
    stdin,
    stdout,
    get killed() {
      return killed;
    },
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    kill(signal) {
      if (exitCode !== null || signalCode !== null || killed) return false;
      if (signal !== "SIGTERM" && signal !== "SIGKILL")
        throw new Error(`Unsupported Claude signal ${signal}`);
      killed = true;
      void process
        .abort(
          new DOMException(`Claude received ${signal}`, "AbortError"),
          signal === "SIGKILL" ? 9 : 15,
        )
        .catch((cause: unknown) =>
          events.emit("error", cause instanceof Error ? cause : new Error(String(cause))),
        );
      return true;
    },
    on: (event, listener) => {
      events.on(event, listener);
    },
    once: (event, listener) => {
      events.once(event, listener);
    },
    off: (event, listener) => {
      events.off(event, listener);
    },
  };
}
