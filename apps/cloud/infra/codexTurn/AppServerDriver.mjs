// This bundled entry supports direct exec and freeform patching without a Code Mode host.
export const proofModel = "gpt-5.5";

export function createAppServerDriver({ sendLine, closeInput }) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const transcript = [];
  const pending = new Map();
  const waiters = new Map();
  let buffer = "",
    nextId = 0,
    failure,
    inputClosed = false;
  const close = () => {
    if (!inputClosed) {
      inputClosed = true;
      closeInput();
    }
  };
  const milestones = new Map();
  function fail(error) {
    failure ??= error;
    for (const p of pending.values()) p.reject(failure);
    pending.clear();
    for (const set of waiters.values()) for (const p of set) p.reject(failure);
    waiters.clear();
    close();
  }
  function emit(message) {
    if (failure) throw failure;
    transcript.push({ direction: "to-engine", message });
    sendLine(JSON.stringify(message) + "\n");
  }
  function milestone(name, value) {
    milestones.set(name, value);
    for (const p of waiters.get(name) ?? []) p.resolve(value);
    waiters.delete(name);
  }
  function receive(message) {
    transcript.push({ direction: "from-engine", message });
    if (message.method === "signalbox/error")
      return fail(new Error(`Engine error: ${message.params.message}`));
    if (message.method === "signalbox/lagged")
      return fail(new Error("App-server dropped notifications"));
    if (message.id !== undefined && message.method !== undefined) {
      emit({
        id: message.id,
        error: { code: -32601, message: "Unexpected server request in approvalPolicy never proof" },
      });
      return fail(new Error(`Unexpected server request ${message.method}`));
    }
    if (message.id !== undefined) {
      const p = pending.get(message.id);
      if (!p) return fail(new Error(`Unexpected response id ${message.id}`));
      pending.delete(message.id);
      if (message.error)
        p.reject(new Error(`App-server ${p.method}: ${JSON.stringify(message.error)}`));
      else p.resolve(message.result);
      return;
    }
    if (message.method === "signalbox/ready") milestone("ready", message.params);
    if (message.method === "turn/completed") milestone("turn-completed", message.params);
  }
  function write(bytes) {
    try {
      buffer += decoder.decode(bytes, { stream: true });
      if (buffer.length > 16 * 1024 * 1024) throw new Error("App-server line exceeds 16 MiB");
      for (;;) {
        const i = buffer.indexOf("\n");
        if (i < 0) break;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim()) receive(JSON.parse(line));
      }
    } catch (e) {
      fail(e);
    }
    return bytes.byteLength;
  }
  function request(method, params) {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      try {
        emit({ id, method, params });
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }
  function wait(name) {
    if (failure) return Promise.reject(failure);
    if (milestones.has(name)) return Promise.resolve(milestones.get(name));
    return new Promise((resolve, reject) => {
      const set = waiters.get(name) ?? new Set();
      set.add({ resolve, reject });
      waiters.set(name, set);
    });
  }
  async function run() {
    try {
      await wait("ready");
      const started = await request("thread/start", {
        cwd: "/workspace",
        model: proofModel,
        modelProvider: "mock",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      const threadId = started.thread?.id;
      if (typeof threadId !== "string") throw new Error("thread/start did not return a thread id");
      await request("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: "Run the command to verify the workspace, add proof.txt with the requested text, then confirm completion.",
          },
        ],
        cwd: "/workspace",
        model: proofModel,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      const completed = await wait("turn-completed");
      if (failure) throw failure;
      if (completed.threadId !== threadId || completed.turn?.status !== "completed")
        throw new Error(`Turn did not complete successfully: ${JSON.stringify(completed)}`);
      return { threadId, turnId: completed.turn.id, transcript };
    } finally {
      close();
    }
  }
  return {
    write,
    run,
    request,
    wait,
    fail,
    transcript,
    get failure() {
      return failure;
    },
  };
}
