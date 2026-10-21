import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HarnessError } from "../Harness.ts";
import type { ComputerBindings } from "../../computer/OpenComputer.ts";
import type { HarnessHostOptions, NativeHostBinding } from "../HarnessSessionHost.ts";
import type { RequestGate } from "./gate.ts";
import { gateNativeRuntime } from "./native.ts";

const isHarnessError = Schema.is(HarnessError);

const harnessError = (operation: HarnessError["operation"], boundary: string) => (cause: unknown) =>
  isHarnessError(cause)
    ? cause
    : new HarnessError({
        operation,
        message: `Harness request admission failed at ${boundary}.`,
        cause,
      });

export function gateHost<G>(
  options: HarnessHostOptions<G>,
  gate: RequestGate,
): HarnessHostOptions<G> {
  const { release, programs, ...runtime } = options;
  return {
    ...gateRuntimeHost(runtime, gate),
    release: { ...release, source: gateReleaseSource(release.source, gate) },
    programs: { ...programs, read: gateProgramReader(programs.read, gate) },
  };
}

function gateReleaseSource(
  source: HarnessHostOptions<unknown>["release"]["source"],
  gate: RequestGate,
): HarnessHostOptions<unknown>["release"]["source"] {
  return { read: (reference, path) => gate.promise(() => source.read(reference, path), false) };
}

function gateProgramReader(
  read: HarnessHostOptions<unknown>["programs"]["read"],
  gate: RequestGate,
): HarnessHostOptions<unknown>["programs"]["read"] {
  return (path, signal) =>
    gate.promise(
      (_context, currentSignal) => read(path, AbortSignal.any([signal, currentSignal])),
      false,
    );
}

// The lazy program reader must survive seeding; its context must exclude the release source.
function gateRuntimeHost<G>(
  options: Omit<HarnessHostOptions<G>, "release" | "programs">,
  gate: RequestGate,
): Omit<HarnessHostOptions<G>, "release" | "programs"> {
  const response = (operation: (signal: AbortSignal) => Promise<Response>, original: AbortSignal) =>
    gate.promise(async (context, signal) => {
      const effectiveSignal = AbortSignal.any([original, signal]);
      const result = await operation(effectiveSignal);
      if (result.body === null) return result;
      const reader = result.body.getReader();
      const release = gate.hold();
      const finish = () => {
        effectiveSignal.removeEventListener("abort", abort);
        release();
      };
      const abort = () => {
        void reader
          .cancel()
          .catch(() => undefined)
          .finally(finish);
      };
      effectiveSignal.addEventListener("abort", abort, { once: true });
      if (effectiveSignal.aborted) abort();
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const chunk = await gate.promise(() => reader.read(), true, context);
              if (chunk.done) {
                finish();
                controller.close();
              } else controller.enqueue(chunk.value);
            } catch (cause) {
              try {
                await reader.cancel(cause);
              } finally {
                finish();
                controller.error(cause);
              }
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              finish();
            }
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
      });
    });
  const persistence = options.files.persistencePorts;
  return {
    ...options,
    files: {
      ...options.files,
      persistencePorts: {
        commits: {
          commit: (input) =>
            gate.promise(
              (_context, signal) =>
                persistence.commits.commit({
                  ...input,
                  signal: AbortSignal.any([input.signal, signal]),
                }),
              false,
            ),
        },
        hydration: {
          fetch: (input) =>
            gate.promise(async (context, signal) => {
              const result = await persistence.hydration.fetch({
                ...input,
                signal: AbortSignal.any([input.signal, signal]),
              });
              if (result.status === "error") return result;
              return {
                status: "ok",
                value: result.value.map((file) => ({
                  ...file,
                  chunks: {
                    async *[Symbol.asyncIterator]() {
                      const iterator = file.chunks[Symbol.asyncIterator]();
                      const release = gate.hold();
                      try {
                        while (true) {
                          const chunk = await gate.promise(() => iterator.next(), false, context);
                          if (chunk.done) return;
                          yield chunk.value;
                        }
                      } finally {
                        try {
                          await iterator.return?.();
                        } finally {
                          release();
                        }
                      }
                    },
                  },
                })),
              };
            }, false),
        },
      },
    },
    modelTransport: (request) =>
      response(
        (signal) => options.modelTransport(new Request(request, { signal })),
        request.signal,
      ),
    executor: {
      forward: (input) =>
        response(
          (signal) =>
            options.executor.forward({
              ...input,
              signal,
              request: new Request(input.request, { signal }),
            }),
          input.signal,
        ),
    },
    ...(options.hooks === undefined
      ? {}
      : {
          hooks: (request, input) =>
            gate.promise((_context, signal) =>
              options.hooks!(request, { signal: AbortSignal.any([input.signal, signal]) }),
            ),
        }),
    bindComputer: (input) =>
      gate
        .admit(
          () =>
            options.bindComputer(input).pipe(
              Effect.map((ports): Omit<ComputerBindings, "files"> => ({
                exec: (command, suppliedSignal, requester) =>
                  gate.promise(async (_context, signal) => {
                    const child = await ports.exec(
                      command,
                      AbortSignal.any([suppliedSignal, signal]),
                      requester,
                    );
                    // Waiting for this receipt keeps an admitted command inside its incoming request.
                    gate.trackExit(child.exited);
                    return child;
                  }),
                port: (port, suppliedSignal) =>
                  gate.promise(async (_context, signal) => {
                    const bound = await ports.port(port, AbortSignal.any([suppliedSignal, signal]));
                    return {
                      fetch: (request: Request) =>
                        response(
                          (signal) => bound.fetch(new Request(request, { signal })),
                          request.signal,
                        ),
                    };
                  }),
                save: (suppliedSignal) =>
                  gate.promise(
                    (_context, signal) => ports.save(AbortSignal.any([suppliedSignal, signal])),
                    false,
                  ),
              })),
            ),
          true,
        )
        .pipe(Effect.mapError(harnessError("open", "Computer binding"))),
    buildRuntime: (input) =>
      gate
        .admit(
          () =>
            options.buildRuntime(input).pipe(
              Effect.map((native): NativeHostBinding => ({
                ...native,
                factory: {
                  ...native.factory,
                  open: (input) =>
                    gate
                      .native(() => native.factory.open(input))
                      .pipe(
                        Effect.map((runtime) => gateNativeRuntime(runtime, gate)),
                        Effect.mapError(harnessError("open", "native factory open")),
                      ),
                },
                configureMcp: (config, signal, load) =>
                  gate
                    .native(() => native.configureMcp(config, signal, load))
                    .pipe(Effect.mapError(harnessError("turn", "native MCP configuration"))),
              })),
            ),
          true,
        )
        .pipe(Effect.mapError(harnessError("open", "native runtime construction"))),
  };
}
