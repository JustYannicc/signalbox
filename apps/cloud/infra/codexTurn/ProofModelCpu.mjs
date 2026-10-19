export const MODEL_CPU_WORK = Object.freeze({
  chunks: 9,
  iterationsPerChunk: 2_000_000_000,
  seed: 1,
});

export function modelCpuChunk(value, iterations) {
  for (let index = 0; index < iterations; index++)
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
  return value;
}

/** Records only proof-owned identities and milestones, never model or user content. */
export function createProofModelCpu({ context, execution, mode }) {
  if (mode !== "all" && mode !== "split") return undefined;
  const sql = context.storage.sql;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS model_cpu_proof (id INTEGER PRIMARY KEY, data TEXT NOT NULL)",
  );
  const generation =
    sql
      .exec(
        "SELECT COALESCE(MAX(json_extract(data, '$.generation')), 0) AS generation FROM model_cpu_proof",
      )
      .one().generation + 1;
  const heapNonce = crypto.randomUUID();
  const rows = [];
  let frames = 0,
    chunks = 0,
    execOpens = 0,
    execFrames = 0,
    disqualified = false,
    checksum = MODEL_CPU_WORK.seed,
    warmup = false;
  const persist = (phase, extra = {}) => {
    const row = {
      phase,
      mode,
      generation,
      heapNonce,
      at: Date.now(),
      frames,
      chunks,
      work: chunks * MODEL_CPU_WORK.iterationsPerChunk,
      checksum,
      execOpens,
      execFrames,
      disqualified,
      wasiStartPending: execution.pending,
      wasiStartEnteredAt: execution.enteredAt,
      ...extra,
    };
    sql.exec("INSERT INTO model_cpu_proof (data) VALUES (?)", JSON.stringify(row));
    rows.push(row);
  };
  persist("created", { owner: "engine-facet", workPlan: MODEL_CPU_WORK });
  const execEvent = (phase) => {
    if (frames > 0 && chunks < MODEL_CPU_WORK.chunks) disqualified = true;
    persist(phase);
  };
  return {
    cpuOnly: true,
    execSocket: {
      serverReceive() {
        execFrames++;
        execEvent("exec-server-frame-received");
      },
      serverClose() {
        execEvent("exec-server-socket-closed");
      },
      opened() {
        execOpens++;
        execEvent("exec-socket-opened");
      },
      observe(socket) {
        return observeNativeSocket(
          socket,
          () => {
            execFrames++;
            execEvent("exec-frame-received");
          },
          () => execEvent("exec-socket-closed"),
        );
      },
    },
    dialStarted() {
      persist("socket-dial-started", { owner: "engine-facet" });
    },
    createdSocket() {
      persist("socket-created", { owner: "engine-facet" });
    },
    acceptedSocket() {
      persist("socket-accepted", { owner: "engine-facet" });
    },
    closedSocket() {
      if (frames > 0 && chunks < MODEL_CPU_WORK.chunks) disqualified = true;
      persist("model-socket-closed");
    },
    async receive(event) {
      if (typeof event.data !== "string") throw new Error("CPU proof requires native text frames");
      const frame = JSON.parse(event.data);
      if (frame.type === "response.created")
        warmup = frame.response.id.startsWith("resp-1069-warmup-");
      if (warmup) return;
      if (!execution.pending)
        throw new Error("Native receive outlived its WASI start continuation");
      frames++;
      persist("received", { frameType: frame.type, callbackOwner: "engine-facet" });
      await context.storage.sync();
      const target =
        mode === "all" ? MODEL_CPU_WORK.chunks : Math.min(frames, MODEL_CPU_WORK.chunks);
      while (chunks < target) {
        persist("work-started", { workIndex: chunks });
        await context.storage.sync();
        checksum = modelCpuChunk(checksum, MODEL_CPU_WORK.iterationsPerChunk);
        chunks++;
        persist("work-finished");
        await context.storage.sync();
      }
      if (frames === MODEL_CPU_WORK.chunks) persist("work-complete");
    },
    inspect() {
      if (disqualified) throw new Error("CPU proof received exec socket traffic during work");
      if (chunks !== MODEL_CPU_WORK.chunks || frames !== MODEL_CPU_WORK.chunks)
        throw new Error("CPU proof did not consume its fixed frame/work sequence");
      persist("native-turn-complete");
      return {
        rows,
        workPlan: MODEL_CPU_WORK,
        checksum,
        work: chunks * MODEL_CPU_WORK.iterationsPerChunk,
      };
    },
  };
}

export function readProofModelCpu(context) {
  const exists = context.storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_cpu_proof'")
    .toArray();
  if (!exists.length) return [];
  return context.storage.sql
    .exec("SELECT data FROM model_cpu_proof ORDER BY id")
    .toArray()
    .map((row) => JSON.parse(row.data));
}

/** The listener still runs on the native socket's captured engine-facet IoContext. */
export function observeProofSocket(socket, proof) {
  if (!proof) return socket;
  return observeNativeSocket(
    socket,
    async (event) => {
      await proof.receive(event);
      if (JSON.parse(event.data).type !== "response.completed")
        socket.send("signalbox-proof-frame-ack");
    },
    () => proof.closedSocket?.(),
  );
}

function observeNativeSocket(socket, beforeMessage, onClose) {
  socket.addEventListener("close", () => onClose?.());
  const listeners = new Map();
  return new Proxy(socket, {
    set: (target, key, value) => Reflect.set(target, key, value, target),
    get(target, key) {
      if (key === "addEventListener")
        return (type, listener, options) => {
          if (type !== "message") return target.addEventListener(type, listener, options);
          const wrapped = async (event) => {
            await beforeMessage(event);
            if (typeof listener === "function") listener.call(target, event);
            else listener.handleEvent(event);
          };
          listeners.set(listener, wrapped);
          target.addEventListener(type, wrapped, options);
        };
      if (key === "removeEventListener")
        return (type, listener, options) => {
          target.removeEventListener(type, listeners.get(listener) ?? listener, options);
          listeners.delete(listener);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
