import type { ChildWorkerCapacity } from "../../computer/ChildWorkerCapacity.ts";
import { CodeModeDelegates } from "./delegates.ts";
import { encodeCodeModeFrame, readCodeModeFrames } from "./frames.ts";
import { parseCodeModeMessage } from "./protocol.ts";
import { CodeModeSession } from "./session.ts";
import {
  fail,
  messageError,
  ok,
  type ClientMessage,
  type CodeModeCellCode,
  type CodeModeCellLoaderPort,
  type HostRequest,
} from "./types.ts";

interface Observation {
  cancel: AbortController;
  yield: AbortController;
}
export interface CodeModeConnectionOptions {
  readonly input: ReadableStream<Uint8Array>;
  readonly output: WritableStream<Uint8Array>;
  readonly signal: AbortSignal;
  readonly loader: CodeModeCellLoaderPort;
  readonly code: CodeModeCellCode;
  readonly capacity: Pick<ChildWorkerCapacity, "tryAcquire">;
}

export async function runCodeModeHostConnection(options: CodeModeConnectionOptions) {
  const writer = options.output.getWriter();
  let writes = Promise.resolve();
  let failure: unknown;
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const sessions = new Map<string, CodeModeSession>();
  const seenSessions = new Set<string>();
  const seenRequests = new Set<number>();
  const active = new Map<number, Observation>();
  const tasks = new Set<Promise<void>>();
  const send = (message: unknown) => {
    writes = writes.then(() => writer.write(encodeCodeModeFrame(message)));
    void writes.catch((error: unknown) => {
      failure ??= error;
      controller.abort(error);
    });
  };
  const delegates = new CodeModeDelegates(send);
  const input = options.input.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
    signal,
  });
  let accepted = false;
  try {
    for await (const raw of readCodeModeFrames(input)) {
      const message = parseCodeModeMessage(raw);
      if (!accepted) {
        const rejection = negotiate(message);
        if (rejection !== undefined) {
          send({ type: "connection/rejected", reason: rejection });
          break;
        }
        accepted = true;
        send({
          type: "connection/ready",
          selectedVersion: 1,
          capabilities:
            message.type === "connection/hello" &&
            [...message.requiredCapabilities, ...message.optionalCapabilities].includes(
              "yield-observation",
            )
              ? ["yield-observation"]
              : [],
        });
        continue;
      }
      switch (message.type) {
        case "connection/hello":
          throw new Error("Received a second CodeMode client hello");
        case "delegate/response":
          delegates.complete(message.id, message.result);
          break;
        case "operation/cancel":
          active.get(message.id)?.cancel.abort(new Error("code-mode request cancelled"));
          break;
        case "operation/yield":
          active.get(message.id)?.yield.abort();
          break;
        case "operation/request": {
          if (seenRequests.has(message.id) || active.has(message.id))
            throw new Error("Duplicate CodeMode request ID");
          const observation = { cancel: new AbortController(), yield: new AbortController() };
          active.set(message.id, observation);
          if (active.size > 256) {
            send({
              type: "operation/response",
              id: message.id,
              result: fail("code-mode host has too many in-flight requests"),
            });
            finish(message.id);
            break;
          }
          const task = handle(message.id, message.request, observation).finally(() => {
            finish(message.id);
            tasks.delete(task);
          });
          tasks.add(task);
          break;
        }
      }
    }
  } catch (error) {
    if (!options.signal.aborted || failure !== undefined) failure ??= error;
  } finally {
    controller.abort(new Error("CodeMode host disconnected"));
    for (const observation of active.values())
      observation.cancel.abort(new Error("CodeMode host disconnected"));
    const shutdown = await Promise.allSettled(
      [...sessions.values()].map((session) => session.shutdown()),
    );
    for (const result of shutdown) if (result.status === "rejected") failure ??= result.reason;
    await Promise.all(tasks);
    try {
      await writes;
    } catch (error) {
      failure ??= error;
    }
    writer.releaseLock();
  }
  if (failure !== undefined) throw failure;

  function finish(id: number) {
    active.delete(id);
    seenRequests.add(id);
    if (seenRequests.size > 4096) seenRequests.delete(seenRequests.values().next().value!);
  }

  async function handle(id: number, request: HostRequest, observation: Observation) {
    const started = performance.now();
    const observe = {
      cancel: AbortSignal.any([signal, observation.cancel.signal]),
      yield: observation.yield.signal,
    };
    try {
      signal.throwIfAborted();
      if (request.method === "session/open") {
        if (sessions.has(request.sessionId) || seenSessions.has(request.sessionId))
          throw new Error(`code-mode session ID '${request.sessionId}' was reused`);
        if (
          request.cellExecutionLimits?.maxHeapSizeBytes !== undefined ||
          request.cellExecutionLimits?.maxYieldTimeMs !== undefined
        )
          throw new Error(
            "CodeMode session execution limits are not supported by this loader port",
          );
        const session = new CodeModeSession({ id: request.sessionId, ...options, delegates, send });
        sessions.set(request.sessionId, session);
        seenSessions.add(request.sessionId);
        if (seenSessions.size > 4096) seenSessions.delete(seenSessions.values().next().value!);
        respond({ type: "session/ready", sessionId: request.sessionId });
        return;
      }
      const session = sessions.get(request.sessionId);
      if (session === undefined) throw new Error(`unknown code-mode session ${request.sessionId}`);
      switch (request.method) {
        case "session/execute": {
          observe.cancel.throwIfAborted();
          const cell = session.execute(request.request, signal);
          respond({ type: "execution/started", cellId: cell.id });
          const response = await session.observe(cell, request.request.yield_time_ms ?? 10_000, {
            cancel: signal,
            yield: observation.yield.signal,
          });
          stamp(response);
          send({ type: "execute/initialResponse", id, result: ok(response) });
          break;
        }
        case "session/wait": {
          const outcome = await session.wait(
            request.request.cell_id,
            request.request.yield_time_ms,
            observe,
          );
          stamp("LiveCell" in outcome ? outcome.LiveCell : outcome.MissingCell);
          respond({ type: "wait/completed", outcome });
          break;
        }
        case "session/terminate": {
          const outcome = await session.terminate(request.cellId);
          stamp("LiveCell" in outcome ? outcome.LiveCell : outcome.MissingCell);
          respond({ type: "wait/completed", outcome });
          break;
        }
        case "session/shutdown":
          sessions.delete(request.sessionId);
          await session.shutdown();
          respond({ type: "session/closed", sessionId: request.sessionId });
          break;
      }
    } catch (error) {
      send({ type: "operation/response", id, result: fail(messageError(error)) });
    }

    function respond(value: unknown) {
      send({ type: "operation/response", id, result: ok(value) });
    }
    function stamp(response: import("./types.ts").RuntimeResponse) {
      const body =
        "Result" in response
          ? response.Result
          : "Yielded" in response
            ? response.Yielded
            : response.Terminated;
      body.code_mode_host_duration_ns = Math.max(
        0,
        Math.trunc((performance.now() - started) * 1_000_000),
      );
    }
  }
}

function negotiate(message: ClientMessage) {
  if (message.type !== "connection/hello")
    return { type: "invalidHello", message: "first message must be connection/hello" };
  if (!message.supportedVersions.includes(1))
    return { type: "noCompatibleVersion", supportedVersions: [1] };
  const missing = message.requiredCapabilities.find(
    (capability) => capability !== "yield-observation",
  );
  return missing === undefined
    ? undefined
    : { type: "missingRequiredCapability", capability: missing };
}
