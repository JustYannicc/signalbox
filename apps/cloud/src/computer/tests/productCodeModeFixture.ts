import type {
  CodeModeCellCode,
  CodeModeCellLoaderPort,
  CodeModeToolDefinition,
} from "../../codeMode/Types.ts";
import { createProductComputer } from "../ProductComputer.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { CODE_MODE_HOST_EXECUTABLE } from "../CodeModeManifest.ts";
import { commandProgramCodes } from "../commandGatewayTesting.ts";
import { childBusyboxFixture } from "../childBusyboxTesting.ts";
import { emptyMachineFilesFixture, machineInventoryFixture } from "../machineInventoryTesting.ts";
import type { ChildWorkerLoaderPort } from "../WorkerLoaderDispatch.ts";
import type { CodeModeLifecycleObserver } from "../../codeMode/Lifecycle.ts";

type Message = Record<string, unknown>;

export async function productCodeModeFixture(options: {
  code: CodeModeCellCode;
  cells: CodeModeCellLoaderPort;
  run?: ChildWorkerLoaderPort["run"];
  onLifecycle?: CodeModeLifecycleObserver;
  onDelegate?: (
    computer: ReturnType<typeof createProductComputer>,
    message: Message,
  ) => Promise<unknown>;
}) {
  const kernel = childBusyboxFixture();
  const capacity = new ChildWorkerCapacity(10, {
    owner: "test/product-code-mode-regressions",
    RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
  });
  const computer = createProductComputer({
    threadId: "code-mode-regressions",
    filesystem: kernel.filesystem,
    wakes: kernel.context.wakes,
    signal: new AbortController().signal,
    onCodeModeLifecycle: options.onLifecycle,
    capacity,
    programs: { ...commandProgramCodes(), codeMode: options.code },
    loader: {
      run:
        options.run ??
        (async () => {
          throw new Error("Unexpected command");
        }),
      cells: options.cells,
    },
    machineInventory: machineInventoryFixture(),
    machine: () => ({
      files: emptyMachineFilesFixture(),
      spawn: async () => {
        throw new Error("Unexpected machine command");
      },
    }),
  });
  const child = await computer.exec(
    {
      executable: CODE_MODE_HOST_EXECUTABLE,
      argv: [CODE_MODE_HOST_EXECUTABLE],
      cwd: kernel.filesystem.cwd,
      env: {},
    },
    new AbortController().signal,
    undefined,
  );
  const writer = child.stdin.getWriter();
  const pending: Message[] = [];
  const waiters: {
    predicate: (message: Message) => boolean;
    resolve: (message: Message) => void;
  }[] = [];
  const send = async (message: unknown) => {
    const payload = new TextEncoder().encode(JSON.stringify(message));
    const frame = new Uint8Array(payload.length + 4);
    new DataView(frame.buffer).setUint32(0, payload.length, true);
    frame.set(payload, 4);
    await writer.write(frame);
  };
  const delegates = new Set<Promise<void>>();
  const output = (async () => {
    const reader = child.stdout.getReader();
    let bytes = new Uint8Array();
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      const joined = new Uint8Array(bytes.length + item.value.length);
      joined.set(bytes);
      joined.set(item.value, bytes.length);
      bytes = joined;
      while (bytes.length >= 4) {
        const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
        if (bytes.length < length + 4) break;
        const message = JSON.parse(
          new TextDecoder().decode(bytes.subarray(4, length + 4)),
        ) as Message;
        bytes = bytes.slice(length + 4);
        if (message.type === "delegate/request" && options.onDelegate !== undefined) {
          const task = options.onDelegate(computer, message).then((value) =>
            send({
              type: "delegate/response",
              id: message.id,
              result: { status: "ok", value: { type: "tool/result", result: value } },
            }),
          );
          delegates.add(task);
          void task.finally(() => delegates.delete(task)).catch(() => undefined);
        } else {
          const index = waiters.findIndex((waiter) => waiter.predicate(message));
          if (index === -1) pending.push(message);
          else waiters.splice(index, 1)[0]!.resolve(message);
        }
      }
    }
  })().catch(ignoreCancelled);
  void output.catch(() => undefined);
  const errors = new Response(child.stderr).arrayBuffer().catch(ignoreCancelled);
  const receive = (predicate: (message: Message) => boolean) => {
    const index = pending.findIndex(predicate);
    if (index !== -1) return Promise.resolve(pending.splice(index, 1)[0]!);
    return new Promise<Message>((resolve) => waiters.push({ predicate, resolve }));
  };
  let nextId = 1;
  const request = async (body: unknown) => {
    const id = nextId++;
    await send({ type: "operation/request", id, request: body });
    return {
      id,
      response: receive((message) => message.type === "operation/response" && message.id === id),
    };
  };
  await send({
    type: "connection/hello",
    supportedVersions: [1],
    requiredCapabilities: [],
    optionalCapabilities: [],
  });
  await receive((message) => message.type === "connection/ready");
  await (
    await request({ method: "session/open", sessionId: "s1" })
  ).response;
  return {
    computer,
    capacity,
    child,
    request,
    receive,
    async execute(source: string, enabled_tools: readonly CodeModeToolDefinition[] = []) {
      const call = await request({
        method: "session/execute",
        sessionId: "s1",
        request: {
          tool_call_id: "call",
          source,
          enabled_tools,
          yield_time_ms: 0,
          max_output_tokens: null,
        },
      });
      await call.response;
      return receive(
        (message) => message.type === "execute/initialResponse" && message.id === call.id,
      );
    },
    async close() {
      await computer.close();
      await child.dispose();
      await Promise.allSettled(delegates);
      writer.releaseLock();
      await output;
      await errors;
      await kernel.close();
    },
  };
}

function ignoreCancelled(error: unknown) {
  if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "ECANCELED")
    throw error;
}
