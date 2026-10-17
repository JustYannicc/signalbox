import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import {
  runnerFrame,
  type ThreadMessage,
  threadFrame,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { RunId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import * as ThreadRunner from "./ThreadRunner.ts";

/**
 * The thread object's end of its Runner's WebSocket. Sockets use the
 * hibernation API, so an idle object can leave memory while its machine stays
 * connected; what a socket has been told lives in its attachment, which
 * survives that. Every decision is `ThreadRunner`'s; this file only frames
 * messages and keeps track of which turn each socket was handed.
 */

const RUNNER_TAG = "runner";

/** Close codes. 4000s are ours; the Runner reconnects after any of them but `refused`. */
const CLOSE = { refused: 4001, replaced: 4002, protocol: 4003, released: 4004 } as const;

interface Attachment {
  readonly generation: number;
  readonly connection: number;
  /** The run this socket's Runner was handed, until it ends or is stopped. */
  readonly sentRunId: RunId | null;
  /** The drain this socket's Runner was asked for (#493); absent: none. */
  readonly sentDrainId?: number | undefined;
  /** This socket's Runner takes `steer` (#562), as its `hello` said. */
  readonly steers?: boolean | undefined;
  /** How many of `sentRunId`'s steers this socket's Runner was handed; absent: none. */
  readonly sentSteers?: number | undefined;
  readonly runtimeResponses?: boolean | undefined;
  readonly sentRuntimeResponses?: ReadonlyArray<string> | undefined;
}

export interface RunnerSocketHost {
  readonly ctx: DurableObjectState;
  readonly run: <A>(effect: Effect.Effect<A, never, ThreadRunner.ThreadRunner>) => Promise<A>;
  /**
   * Whether the turn waits for its pull requests' reads, which the object's
   * alarm makes before it hands work out again (#495). Never rejects.
   */
  readonly holdsTurn: () => Promise<boolean>;
  /** Arms the object's alarm after anything that may have left it work. */
  readonly afterChange: (work?: ThreadRunner.RunnerWork) => Promise<void>;
}

const runner = ThreadRunner.ThreadRunner;

const send = (socket: WebSocket, message: ThreadMessage) => {
  try {
    socket.send(threadFrame.encode(message));
  } catch {
    // Already closing; the Runner reconnects and is told again.
  }
};

const attachmentOf = (socket: WebSocket): Attachment | null =>
  (socket.deserializeAttachment() as Attachment | null) ?? null;

const close = (socket: WebSocket, code: number, reason: string) => {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed.
  }
};

/** Accepts an upgrade on the connect path. The Runner proves who it is in `hello`. */
export function acceptRunnerSocket(ctx: DurableObjectState): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  ctx.acceptWebSocket(server, [RUNNER_TAG]);
  return new Response(null, { status: 101, webSocket: client });
}

export const isRunnerSocket = (ctx: DurableObjectState, socket: WebSocket) =>
  ctx.getTags(socket).includes(RUNNER_TAG);

/** Tells every socket of `generation` to go away: its machine's lease is over. */
export function endRunners(ctx: DurableObjectState, generation: number, reason: string) {
  for (const socket of ctx.getWebSockets(RUNNER_TAG)) {
    if (attachmentOf(socket)?.generation !== generation) continue;
    send(socket, { type: "end", reason });
    close(socket, CLOSE.released, reason);
  }
}

/**
 * Hands the connected Runner what the thread wants now: `turn.start` for a
 * run waiting on it, `steer` for each message sent into the run it holds, and
 * `interrupt` for a run it was handed that is no longer live. Safe to call
 * any time; the Runner ignores repeats.
 */
export async function pushRunnerWork(host: RunnerSocketHost): Promise<ThreadRunner.RunnerWork> {
  const work = await host.run(runner.use((service) => service.work));
  const turn =
    work.turn !== null &&
    work.modelToken !== null &&
    work.sessions !== null &&
    !(await host.holdsTurn())
      ? { turn: work.turn, modelToken: work.modelToken, sessions: work.sessions }
      : null;
  const handedOut = turn?.turn.runId ?? null;
  const starting =
    handedOut !== null &&
    host.ctx.getWebSockets(RUNNER_TAG).some((socket) => {
      const attachment = attachmentOf(socket);
      return attachment?.generation === work.generation && attachment.sentRunId !== handedOut;
    });
  // Asked only when a turn is handed out, and before the sends: it's a call to the owner's
  // object, and nothing may run between reading a socket's attachment and writing it back.
  const author =
    starting && work.drive !== null
      ? await host.run(runner.use((service) => service.commitAuthor))
      : null;
  // Asked the same way, and only when the chain names an Environment.
  const secretsToken =
    starting && work.secrets.length > 0
      ? await host.run(runner.use((service) => service.secretsToken))
      : null;
  // Asked the same way, and only for a turn that resumes its harness session.
  const handed = turn?.turn ?? null;
  const freshSessionText =
    starting && handed !== null && handed.providerThread.nativeThreadRef !== null
      ? await host.run(runner.use((service) => service.freshSessionText(handed)))
      : null;
  const drive: DriveAccess | null =
    work.drive === null || author === null ? work.drive : { ...work.drive, author };
  for (const socket of host.ctx.getWebSockets(RUNNER_TAG)) {
    const attachment = attachmentOf(socket);
    if (attachment === null || attachment.generation !== work.generation) continue;
    let sentRunId = attachment.sentRunId;
    let sentSteers = attachment.sentSteers ?? 0;
    let sentRuntimeResponses = attachment.sentRuntimeResponses ?? [];
    if (sentRunId !== null && sentRunId !== work.activeRunId) {
      send(socket, { type: "interrupt", runId: sentRunId });
      sentRunId = null;
      sentSteers = 0;
      sentRuntimeResponses = [];
    }
    if (turn !== null && sentRunId !== turn.turn.runId) {
      send(socket, {
        type: "turn.start",
        turn: freshSessionText === null ? turn.turn : { ...turn.turn, freshSessionText },
        modelToken: turn.modelToken,
        drive,
        sessions: turn.sessions,
        // The owner's 1Password token rides only in this frame; never log it.
        ...(work.secrets.length === 0
          ? {}
          : { secrets: { token: secretsToken, environments: work.secrets } }),
      });
      sentRunId = turn.turn.runId;
      sentSteers = 0;
      sentRuntimeResponses = [];
    }
    // Steers count from the oldest, so the ones not handed out yet are the tail.
    if (attachment.steers === true && sentRunId !== null && sentRunId === work.activeRunId) {
      for (const message of work.steers.slice(sentSteers)) {
        send(socket, { type: "steer", runId: sentRunId, message });
      }
      sentSteers = Math.max(sentSteers, work.steers.length);
    }
    if (attachment.runtimeResponses === true && sentRunId === work.activeRunId) {
      for (const response of work.runtimeResponses) {
        if (response.runId !== sentRunId || sentRuntimeResponses.includes(response.requestId))
          continue;
        send(socket, response);
        sentRuntimeResponses = [...sentRuntimeResponses, response.requestId];
      }
    }
    // A drain asked for and not answered yet, once per connection (#493).
    let sentDrainId = attachment.sentDrainId;
    if (work.drain !== null && sentDrainId !== work.drain) {
      send(socket, { type: "drain", id: work.drain });
      sentDrainId = work.drain;
    }
    if (
      sentRunId !== attachment.sentRunId ||
      sentDrainId !== attachment.sentDrainId ||
      sentSteers !== (attachment.sentSteers ?? 0) ||
      sentRuntimeResponses !== attachment.sentRuntimeResponses
    ) {
      socket.serializeAttachment({
        ...attachment,
        sentRunId,
        sentDrainId,
        sentSteers,
        sentRuntimeResponses,
      } satisfies Attachment);
    }
  }
  return work;
}

export async function onRunnerMessage(
  host: RunnerSocketHost,
  socket: WebSocket,
  data: string | ArrayBuffer,
) {
  let message;
  try {
    message = runnerFrame.decode(typeof data === "string" ? data : new TextDecoder().decode(data));
  } catch {
    close(socket, CLOSE.protocol, "Unreadable frame.");
    return;
  }
  const attachment = attachmentOf(socket);
  switch (message.type) {
    case "hello": {
      const result = await host.run(runner.use((service) => service.hello(message)));
      if (result._tag === "refused") {
        send(socket, { type: "refused", reason: result.reason, message: result.message });
        close(socket, CLOSE.refused, result.reason);
        return;
      }
      // One Runner per thread: a reconnect replaces the socket it left behind.
      for (const other of host.ctx.getWebSockets(RUNNER_TAG)) {
        if (other !== socket) close(other, CLOSE.replaced, "Replaced by a newer connection.");
      }
      // A reconnect already holds its live run: what the thread decides about
      // that run (a Stop above all) is told on this connection.
      socket.serializeAttachment({
        generation: result.generation,
        connection: result.connection,
        sentRunId: result.heldRunId,
        steers: message.steers === true,
        runtimeResponses: message.runtimeResponses === true,
      } satisfies Attachment);
      send(socket, {
        type: "welcome",
        generation: result.generation,
        ackedSequence: result.ackedSequence,
        activeRunId: result.activeRunId,
      });
      await host.afterChange(await pushRunnerWork(host));
      return;
    }
    case "batch": {
      if (attachment === null) {
        close(socket, CLOSE.protocol, "Say hello first.");
        return;
      }
      const result = await host.run(
        runner.use((service) =>
          service.batch({
            generation: attachment.generation,
            sequence: message.sequence,
            items: message.items,
          }),
        ),
      );
      switch (result._tag) {
        case "ack":
          send(socket, { type: "ack", sequence: result.sequence });
          await host.afterChange(await pushRunnerWork(host));
          return;
        case "stale":
          send(socket, { type: "end", reason: "A newer machine replaced this one." });
          close(socket, CLOSE.released, "stale generation");
          return;
        case "out_of_order":
          close(socket, CLOSE.protocol, `Resend after ${result.ackedSequence}.`);
          return;
      }
      return;
    }
    case "end":
      if (attachment !== null) {
        await host.run(
          runner.use((service) => service.ended(attachment.generation, message.reason)),
        );
        await host.afterChange();
      }
      close(socket, 1000, "end");
      return;
  }
}

/**
 * A socket went away. Unless a newer one took over, the Runner has a while to
 * come back. A close the Runner started is answered, completing the handshake
 * it waits on before it can reconnect.
 */
export async function onRunnerClose(
  host: RunnerSocketHost,
  socket: WebSocket,
  code = 1000,
  reason = "",
) {
  // 1005 and 1006 only describe a close; they cannot be sent.
  close(socket, code === 1005 || code === 1006 ? 1000 : code, reason);
  const attachment = attachmentOf(socket);
  if (attachment === null) return;
  const replaced = host.ctx
    .getWebSockets(RUNNER_TAG)
    .some((other) => other !== socket && attachmentOf(other)?.generation === attachment.generation);
  if (replaced) return;
  const detail = `code ${code}${reason === "" ? "" : `, ${reason}`}`;
  await host.run(runner.use((service) => service.disconnected({ ...attachment, detail })));
  await host.afterChange();
}
