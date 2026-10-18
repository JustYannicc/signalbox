import {
  isRunnerSocket,
  onRunnerClose,
  type RunnerSocketAttachment,
  type RunnerSocketHost,
} from "./runner/runnerSockets.ts";

export const RUNNER_SILENCE_LIMIT_MS = 45_000;

/** Checks only when the Runner could have missed the same three pings as its client. */
export const inspect = async (host: RunnerSocketHost, now: number): Promise<number | null> => {
  let wakeAt: number | null = null;
  for (const socket of host.ctx.getWebSockets()) {
    if (!isRunnerSocket(host.ctx, socket)) continue;
    const attachment = (socket.deserializeAttachment() as RunnerSocketAttachment | null) ?? null;
    if (
      attachment === null ||
      attachment.inactive === true ||
      attachment.heartbeatExpiredAt !== undefined
    ) {
      continue;
    }

    const autoResponseAt = host.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? null;
    const lastActivityAt = attachment.lastActivityAt ?? autoResponseAt ?? now;
    if (attachment.lastActivityAt === undefined) {
      socket.serializeAttachment({ ...attachment, lastActivityAt });
    }
    const deadline = Math.max(lastActivityAt, autoResponseAt ?? 0) + RUNNER_SILENCE_LIMIT_MS;
    if (now >= deadline) {
      socket.serializeAttachment({
        ...attachment,
        lastActivityAt,
        heartbeatExpiredAt: now,
      });
      await onRunnerClose(host, socket, 1006, "heartbeat timed out");
      continue;
    }
    wakeAt = wakeAt === null ? deadline : Math.min(wakeAt, deadline);
  }
  return wakeAt;
};
