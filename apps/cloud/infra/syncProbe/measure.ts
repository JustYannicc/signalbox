// @effect-diagnostics globalDate:off globalTimers:off globalFetch:off globalConsole:off -- This one-off CI harness runs on Node and measures its native WebSocket and HTTP boundaries.
import * as NodeAssert from "node:assert/strict";
import * as NodeBuffer from "node:buffer";

import { LunoraClient } from "lunorash/client";

import { api } from "./lunora/_generated/api.ts";
import { issueProbeToken, PROBE_LEVELS } from "./identity.ts";

interface FrameTotals {
  incoming: number;
  incomingBytes: number;
  outgoing: number;
  outgoingBytes: number;
}

interface ClientState {
  readonly levelId: string;
  readonly sockets: WebSocket[];
  readonly listeners: Set<() => void>;
  readonly values: number[];
  readonly errors: unknown[];
  client: LunoraClient | undefined;
  unsubscribe: (() => void) | undefined;
  opens: number;
  closes: number;
}

interface SqlActivity {
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly statements: number;
}

interface Metrics {
  readonly bootId: string;
  readonly sql: SqlActivity;
}

const workerUrlText = process.env.SYNC_PROBE_URL;
const probeSecret = process.env.PROBE_SECRET;
if (workerUrlText === undefined || probeSecret === undefined) {
  throw new Error("SYNC_PROBE_URL and PROBE_SECRET are required.");
}

const workerUrl = new URL(workerUrlText);
if (workerUrl.protocol !== "https:" || !workerUrl.hostname.endsWith(".workers.dev")) {
  throw new Error("The sync probe must target an isolated HTTPS Worker preview URL.");
}
workerUrl.pathname = "/";
workerUrl.search = "";
workerUrl.hash = "";

const websocketUrl = new URL("/_lunora/ws", workerUrl);
websocketUrl.protocol = "wss:";
const runKey = `probe:${process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;
const counterKey = runKey;
const frameTotals: FrameTotals = { incoming: 0, incomingBytes: 0, outgoing: 0, outgoingBytes: 0 };
const states: ClientState[] = [];
const defined = <Value>(value: Value) => ({ defined: true as const, value });

const nativeWebSocket = globalThis.WebSocket;
if (typeof nativeWebSocket !== "function") {
  throw new Error("This probe requires Node's WebSocket implementation.");
}

const byteLength = (data: unknown) => {
  if (typeof data === "string") return NodeBuffer.Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob === "function" && data instanceof Blob) return data.size;
  return 0;
};

const measuredWebSocket = (state: ClientState): typeof WebSocket =>
  class MeasuredWebSocket extends nativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      state.sockets.push(this);
      this.addEventListener("open", () => {
        state.opens += 1;
        notify(state);
      });
      this.addEventListener("message", (event) => {
        const size = byteLength((event as MessageEvent<unknown>).data);
        frameTotals.incoming += 1;
        frameTotals.incomingBytes += size;
      });
      this.addEventListener("close", () => {
        state.closes += 1;
        notify(state);
      });
    }

    override send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
      frameTotals.outgoing += 1;
      frameTotals.outgoingBytes += byteLength(data);
      // Node's WebSocket accepts the typed-array views used here; DOM typings
      // admit SharedArrayBuffer-backed views that the browser signature omits.
      super.send(data as string | BufferSource | Blob);
    }
  };

function notify(state: ClientState) {
  for (const listener of state.listeners) listener();
}

function safeError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  if (error instanceof Error) return error.name;
  return "unknown error";
}

function waitFor(
  watched: ReadonlyArray<ClientState>,
  predicate: () => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      for (const state of watched) state.listeners.delete(check);
      if (error === undefined) resolve();
      else reject(error);
    };
    const check = () => {
      const failed = watched.flatMap((state) => state.errors).at(0);
      if (failed !== undefined) {
        finish(new Error(`${label} failed: ${safeError(failed)}.`));
      } else if (predicate()) {
        finish();
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `${label} timed out; current values: ${watched.map((state) => state.values.at(-1) ?? "none").join(", ")}.`,
          ),
        ),
      timeoutMs,
    );
    for (const state of watched) state.listeners.add(check);
    check();
  });
}

function isNumberWireValue(
  value: unknown,
): value is { readonly defined: true; readonly value: number } {
  return isRecord(value) && value.defined === true && typeof value.value === "number";
}

function isValue(value: unknown): value is {
  readonly _tag: "Value";
  readonly value: { readonly defined: true; readonly value: number };
  readonly cursor: string;
} {
  return (
    isRecord(value) &&
    value._tag === "Value" &&
    isNumberWireValue(value.value) &&
    typeof value.cursor === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readMetrics(levelId: string, token: string): Promise<Metrics> {
  const response = await fetch(new URL("/_probe/metrics", workerUrl), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Metrics request failed with HTTP ${response.status}.`);
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    typeof body.bootId !== "string" ||
    !isRecord(body.sql) ||
    typeof body.sql.rowsRead !== "number" ||
    typeof body.sql.rowsWritten !== "number" ||
    typeof body.sql.statements !== "number"
  ) {
    throw new Error(`Metrics response for ${levelId} has an invalid shape.`);
  }
  return {
    bootId: body.bootId,
    sql: {
      rowsRead: body.sql.rowsRead,
      rowsWritten: body.sql.rowsWritten,
      statements: body.sql.statements,
    },
  };
}

const sleep = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

try {
  const tokens = new Map<string, string>();
  for (const levelId of PROBE_LEVELS)
    tokens.set(levelId, await issueProbeToken(probeSecret, levelId));

  for (const levelId of PROBE_LEVELS) {
    const token = tokens.get(levelId);
    NodeAssert.ok(token !== undefined);
    for (let index = 0; index < 4; index += 1) {
      const state: ClientState = {
        levelId,
        sockets: [],
        listeners: new Set(),
        values: [],
        errors: [],
        client: undefined,
        unsubscribe: undefined,
        opens: 0,
        closes: 0,
      };
      const client = new LunoraClient({
        url: workerUrl.origin,
        wsUrl: websocketUrl.toString(),
        wsToken: token,
        WebSocket: measuredWebSocket(state),
        heartbeatIntervalMs: 0,
        connectTimeoutMs: 10_000,
        reconnect: { initialDelayMs: 100, maxDelayMs: 500, jitter: false },
        persistence: false,
        queryCache: false,
      });
      client.setAuthToken(token, "sync-probe-user");
      state.client = client;
      state.unsubscribe = client.subscribe(
        api.counter.view_value,
        { input: defined({ levelId, key: counterKey }) },
        (result) => {
          if (!isValue(result)) {
            state.errors.push(new Error("Unexpected counter view result."));
          } else {
            state.values.push(result.value.value);
          }
          notify(state);
        },
        {
          shardKey: levelId,
          onError: (error) => {
            state.errors.push(error);
            notify(state);
          },
        },
      );
      states.push(state);
    }
  }

  await waitFor(
    states,
    () => states.every((state) => state.values.length >= 1),
    "initial subscriptions",
  );
  NodeAssert.ok(
    states.every((state) => state.values[0] === 0),
    "each level should start with its own empty counter",
  );

  for (const state of states) {
    NodeAssert.ok(state.client !== undefined);
    const opposite = state.levelId === "top:test" ? "folder:test" : "top:test";
    const wrongInputError = await state.client
      .query(
        api.counter.view_value,
        { input: defined({ levelId: opposite, key: counterKey }) },
        { shardKey: state.levelId },
      )
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    NodeAssert.ok(
      wrongInputError !== undefined,
      "a client must not query another level through its own shard",
    );
    NodeAssert.equal(safeError(wrongInputError), "FORBIDDEN");

    const wrongShardError = await state.client
      .query(
        api.counter.view_value,
        { input: defined({ levelId: opposite, key: counterKey }) },
        { shardKey: opposite },
      )
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    NodeAssert.ok(
      wrongShardError !== undefined,
      "a client must not route into another level's shard",
    );
    NodeAssert.equal(safeError(wrongShardError), "FORBIDDEN_SHARD");
  }

  const deliveryStart = states.map((state) => state.values.length);
  for (const levelId of PROBE_LEVELS) {
    const clients = states.filter((state) => state.levelId === levelId);
    const writer = clients[0];
    NodeAssert.ok(writer?.client !== undefined);
    const amount = levelId === "top:test" ? 1 : 2;
    let expectedValue = 0;
    for (let write = 0; write < 20; write += 1) {
      expectedValue += amount;
      const result: unknown = await writer.client.mutation(
        api.counter.change_increment,
        {
          input: defined({ levelId, key: counterKey, amount }),
          operationKey: `${runKey}:${levelId}:write:${write}`,
        },
        { shardKey: levelId },
      );
      NodeAssert.ok(
        isRecord(result) && result._tag === "Committed" && isNumberWireValue(result.value),
        "the unfenced probe write should commit synchronously",
      );
      NodeAssert.equal(result.value.value, expectedValue);
      await waitFor(
        clients,
        () => clients.every((state) => state.values.at(-1) === expectedValue),
        `${levelId} write ${write + 1} delivery`,
      );
    }
  }

  const measuredDeliveries = states.reduce(
    (sum, state, index) =>
      sum + state.values.length - (deliveryStart[index] ?? state.values.length),
    0,
  );
  NodeAssert.equal(
    measuredDeliveries,
    160,
    "20 writes per level must reach each of four clients on that level",
  );

  for (const state of states) {
    const expected = state.levelId === "top:test" ? 20 : 40;
    NodeAssert.equal(state.values.at(-1), expected);
  }

  const reconnecting = states.find((state) => state.levelId === "top:test");
  const activeTopClients = states.filter(
    (state) => state.levelId === "top:test" && state !== reconnecting,
  );
  NodeAssert.ok(reconnecting?.client !== undefined);
  const oldSocket = reconnecting.sockets.at(-1);
  NodeAssert.ok(oldSocket !== undefined);
  const opensBefore = reconnecting.opens;
  const closesBefore = reconnecting.closes;
  oldSocket.close(4000, "sync probe reconnect");
  await waitFor([reconnecting], () => reconnecting.closes > closesBefore, "forced disconnect");

  const topWriter = activeTopClients[0];
  NodeAssert.ok(topWriter?.client !== undefined);
  const reconnectResult = await topWriter.client.mutation(
    api.counter.change_increment,
    {
      input: defined({ levelId: "top:test", key: counterKey, amount: 7 }),
      operationKey: `${runKey}:top:test:reconnect`,
    },
    { shardKey: "top:test" },
  );
  NodeAssert.ok(
    isRecord(reconnectResult) &&
      reconnectResult._tag === "Committed" &&
      isNumberWireValue(reconnectResult.value),
  );
  NodeAssert.equal(reconnectResult.value.value, 27);
  await waitFor(
    activeTopClients,
    () => activeTopClients.every((state) => state.values.at(-1) === 27),
    "connected clients after reconnect write",
  );
  await waitFor(
    [reconnecting],
    () => reconnecting.opens > opensBefore && reconnecting.values.at(-1) === 27,
    "reconnect catch-up",
  );

  const idleMs = Number(process.env.SYNC_PROBE_IDLE_MS ?? 15_000);
  NodeAssert.ok(
    Number.isSafeInteger(idleMs) && idleMs >= 2_000 && idleMs <= 60_000,
    "idle interval must be 2-60 seconds",
  );
  const tokenByLevel = new Map(tokens);
  const beforeSql = new Map<string, Metrics>();
  for (const levelId of PROBE_LEVELS) {
    const token = tokenByLevel.get(levelId);
    NodeAssert.ok(token !== undefined);
    beforeSql.set(levelId, await readMetrics(levelId, token));
  }

  const startFrames = { ...frameTotals };
  const idleStartedAt = Date.now();
  await sleep(idleMs);
  const idleDurationMs = Date.now() - idleStartedAt;
  const idleFrames = {
    incoming: frameTotals.incoming - startFrames.incoming,
    incomingBytes: frameTotals.incomingBytes - startFrames.incomingBytes,
    outgoing: frameTotals.outgoing - startFrames.outgoing,
    outgoingBytes: frameTotals.outgoingBytes - startFrames.outgoingBytes,
  };

  const afterSql = new Map<string, Metrics>();
  for (const levelId of PROBE_LEVELS) {
    const token = tokenByLevel.get(levelId);
    NodeAssert.ok(token !== undefined);
    afterSql.set(levelId, await readMetrics(levelId, token));
  }

  const idleSql = Object.fromEntries(
    PROBE_LEVELS.map((levelId) => {
      const before = beforeSql.get(levelId);
      const after = afterSql.get(levelId);
      NodeAssert.ok(before !== undefined && after !== undefined);
      return [
        levelId,
        {
          rowsRead: after.sql.rowsRead,
          rowsWritten: after.sql.rowsWritten,
          statements: after.sql.statements,
        } satisfies SqlActivity,
      ];
    }),
  );
  const bootIdChanged = Object.fromEntries(
    PROBE_LEVELS.map((levelId) => [
      levelId,
      beforeSql.get(levelId)?.bootId !== afterSql.get(levelId)?.bootId,
    ]),
  );

  console.log(
    `SYNC_PROBE_RESULT ${JSON.stringify({
      clients: states.length,
      levels: PROBE_LEVELS.length,
      workloadWrites: 40,
      deliveredChanges: measuredDeliveries,
      isolatedFinalValues: { "top:test": 20, "folder:test": 40 },
      crossLevelReadsDenied: states.length,
      crossLevelShardRoutingDenied: states.length,
      reconnect: {
        writes: 1,
        caughtUpValue: reconnecting.values.at(-1),
        reopened: reconnecting.opens > opensBefore,
      },
      idle: {
        durationMs: idleDurationMs,
        websocketFrames: idleFrames,
        sql: idleSql,
        bootIdChanged,
        hibernationObserved: Object.values(bootIdChanged).some(Boolean),
      },
    })}`,
  );
} finally {
  for (const state of states) {
    state.unsubscribe?.();
    state.client?.close();
  }
}
