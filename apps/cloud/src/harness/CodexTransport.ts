import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type { CodexAppServerSessionClient } from "@signalbox/provider-codex/clientFactory";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import type { CodexHarnessProcess, CodexHarnessProcessOptions } from "./codex/types.ts";

const encodeBootstrap = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const bootstrapEncoder = new TextEncoder();

/** One writer sends bootstrap first and remains owned until every client write settles. */
export function createCodexInput(
  options: Pick<CodexHarnessProcessOptions, "stdio" | "bootstrap">,
  fail: (error: unknown) => void,
) {
  const writer = options.stdio.stdin.getWriter();
  const bootstrapBytes = bootstrapEncoder.encode(encodeBootstrap(options.bootstrap) + "\n");
  const bootstrap = writer.write(bootstrapBytes);
  const pending = new Set<Promise<unknown>>([bootstrap]);
  const track = <A>(promise: Promise<A>) => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      (error: unknown) => {
        pending.delete(promise);
        fail(error);
      },
    );
    return promise;
  };
  track(bootstrap);
  const stdin = new WritableStream<Uint8Array>({
    write: (bytes) => track(bootstrap.then(() => writer.write(bytes))),
    close: () => track(bootstrap.then(() => writer.close())),
    abort(reason) {
      options.stdio.stopInput(reason);
    },
  });
  return {
    stdin,
    bootstrap,
    bootstrapBytes: bootstrapBytes.byteLength,
    async dispose() {
      while (pending.size > 0) await Promise.allSettled(pending);
      writer.releaseLock();
    },
  };
}

const decodeNotification = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ method: Schema.String, params: Schema.optionalKey(Schema.Unknown) }),
  ),
);
const standardFormInputReady = Schema.is(
  Schema.Struct({
    host_capabilities: Schema.Struct({ standard_form_input: Schema.Literal(true) }),
  }),
);
const MAX_LINE_CHARACTERS = 16 * 1024 * 1024;

export function observeCodexReady(
  source: ReadableStream<Uint8Array>,
  expectedCapabilities?: { readonly standard_form_input: boolean },
) {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const ready = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  void ready.catch(() => undefined);
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  const decoder = new TextDecoder();
  let remainder = "";
  const stdout = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, output) {
        try {
          if (!settled) {
            remainder += decoder.decode(bytes, { stream: true });
            for (let end = remainder.indexOf("\n"); end >= 0; end = remainder.indexOf("\n")) {
              const line = remainder.slice(0, end);
              remainder = remainder.slice(end + 1);
              if (line.length > MAX_LINE_CHARACTERS)
                throw new Error("Codex stdout line exceeds 16 MiB");
              const notification = line.includes('"signalbox/ready"')
                ? decodeNotification(line)
                : undefined;
              if (notification?.method === "signalbox/ready") {
                if (
                  expectedCapabilities?.standard_form_input === true &&
                  !standardFormInputReady(notification.params)
                )
                  throw new Error(
                    "Codex did not negotiate the requested standard form input capability",
                  );
                settled = true;
                resolve();
                remainder = "";
                break;
              }
            }
            if (remainder.length > MAX_LINE_CHARACTERS)
              throw new Error("Codex stdout line exceeds 16 MiB");
          }
          output.enqueue(bytes);
        } catch (error) {
          fail(error);
          throw error;
        }
      },
      flush() {
        fail(new Error("Codex stdout ended before signalbox/ready"));
      },
    }),
  );
  return { stdout, ready, fail };
}

const clientEncoder = new TextEncoder();

export const makeCodexProcessClient = Effect.fn("CodexTransport.makeProcessClient")(function* (
  process: CodexHarnessProcess,
  onStderr: (bytes: Uint8Array) => Effect.Effect<void> = () => Effect.void,
) {
  const ioError = (method: string) => (cause: unknown) => {
    void process.abort(cause).catch(() => undefined);
    return PlatformError.systemError({ _tag: "Unknown", module: "Stdio", method, cause });
  };
  const stderr = Stream.fromReadableStream({
    evaluate: () => process.stderr,
    onError: ioError("stderr"),
  });
  yield* stderr.pipe(Stream.runForEach(onStderr), Effect.orDie, Effect.forkScoped);
  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromReadableStream({ evaluate: () => process.stdout, onError: ioError("stdin") }),
    stdout: () =>
      Sink.mapInput(
        Sink.fromWritableStream({
          evaluate: () => process.stdin,
          onError: ioError("stdout"),
          closeOnDone: false,
        }),
        (chunk: string | Uint8Array) =>
          typeof chunk === "string" ? clientEncoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });
  const termination = Effect.match(
    Effect.tryPromise({
      try: () => process.exited,
      catch: (cause) =>
        new CodexErrors.CodexAppServerTransportError({
          operation: "read-process-exit-status",
          cause,
        }),
    }),
    {
      onFailure: (error) => error,
      onSuccess: (status) =>
        new CodexErrors.CodexAppServerProcessExitedError({ code: status.exitCode }),
    },
  );
  // make starts the reader fibers before the caller waits for the ready notification.
  const client = yield* CodexClient.make(stdio, {}, termination);
  return {
    ...client,
    preinitialized: Effect.tryPromise({
      try: () => process.ready,
      catch: (cause) =>
        new CodexErrors.CodexAppServerTransportError({
          operation: "read-input-stream",
          cause,
        }),
    }),
  } satisfies CodexAppServerSessionClient;
});
