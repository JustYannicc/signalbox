import type {
  CodeModeCellCode,
  CodeModeCellLoaderPort,
  CodeModeExecuteRequest,
} from "../../CodeModeHost.ts";
import { runCodeModeHostConnection } from "../../CodeModeHost.ts";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";

export function hostClient(
  loader: CodeModeCellLoaderPort,
  code: CodeModeCellCode,
  capacity = new ChildWorkerCapacity(2, { owner: "test/src-harness-codemode-tests-client-1" }),
) {
  let enqueue: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      enqueue = controller;
    },
  });
  const pending: Array<Record<string, unknown>> = [];
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }> = [];
  const output = new WritableStream<Uint8Array>({
    write(bytes) {
      const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
      const message = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as Record<
        string,
        unknown
      >;
      messages.push(message);
      const index = waiters.findIndex((waiter) => waiter.predicate(message));
      if (index === -1) pending.push(message);
      else waiters.splice(index, 1)[0]!.resolve(message);
    },
  });
  const controller = new AbortController();
  const finished = runCodeModeHostConnection({
    input,
    output,
    signal: controller.signal,
    loader,
    code,
    cellCapacity: capacity,
  });
  void finished.catch(() => undefined);
  let nextId = 1;
  const send = (message: unknown) => {
    const payload = new TextEncoder().encode(JSON.stringify(message));
    const frame = new Uint8Array(payload.length + 4);
    new DataView(frame.buffer).setUint32(0, payload.length, true);
    frame.set(payload, 4);
    enqueue!.enqueue(frame);
  };
  const receive = (predicate: (message: Record<string, unknown>) => boolean) => {
    const index = pending.findIndex(predicate);
    if (index !== -1) return Promise.resolve(pending.splice(index, 1)[0]!);
    return new Promise<Record<string, unknown>>((resolve) => waiters.push({ predicate, resolve }));
  };
  const request = (body: unknown) => {
    const id = nextId++;
    send({ type: "operation/request", id, request: body });
    return {
      id,
      response: receive((message) => message.type === "operation/response" && message.id === id),
    };
  };
  return {
    send,
    messages,
    receive,
    request,
    capacity,
    finished,
    async hello(requiredCapabilities: string[] = [], optionalCapabilities = ["yield-observation"]) {
      send({
        type: "connection/hello",
        supportedVersions: [1],
        requiredCapabilities,
        optionalCapabilities,
      });
      return receive(
        (message) => message.type === "connection/ready" || message.type === "connection/rejected",
      );
    },
    open: (sessionId = "s1") => request({ method: "session/open", sessionId }).response,
    async execute(source: string, options: Partial<CodeModeExecuteRequest> = {}, sessionId = "s1") {
      const call = request({
        method: "session/execute",
        sessionId,
        request: {
          tool_call_id: "call",
          source,
          enabled_tools: [],
          yield_time_ms: 1000,
          max_output_tokens: null,
          ...options,
        },
      });
      await call.response;
      return receive(
        (message) => message.type === "execute/initialResponse" && message.id === call.id,
      );
    },
    wait: (cell_id: string, yield_time_ms = 1000, sessionId = "s1") =>
      request({ method: "session/wait", sessionId, request: { cell_id, yield_time_ms } }),
    close() {
      enqueue!.close();
      return finished;
    },
    abort() {
      controller.abort();
      return finished;
    },
  };
}
