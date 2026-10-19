// @effect-diagnostics globalTimers:off - this Promise boundary has no Effect runtime; the timer only bounds a pending Runner acknowledgement.
import type { ExecCommand, ExecReport } from "@signalbox/runner-protocol/ExecProtocol";

type Ack = Extract<ExecReport, { type: "ack" }>;

export class ExecCommandRejected extends Error {
  readonly report: Ack;

  constructor(report: Ack) {
    super(`Runner rejected process command (${report.error?.code ?? "process_error"})`);
    this.report = report;
  }
}
type PendingAck = {
  readonly operation: ExecCommand["type"];
  readonly requestId?: string;
  readonly writeId?: string;
  readonly resolve: (report: Ack) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

const ackKey = (operation: ExecCommand["type"], operationId: string) =>
  `${operation}:${operationId}`;

/** Matches Runner application acknowledgements to the command that is waiting for them. */
export class ExecCommandAcks {
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingAck>();

  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
  }

  send(command: ExecCommand, send: (command: ExecCommand) => void): Promise<Ack> {
    const operationId = "writeId" in command ? command.writeId : command.requestId;
    const key = ackKey(command.type, operationId);
    return new Promise<Ack>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(key);
        reject(new Error("Timed out waiting for Runner command acknowledgement"));
      }, this.#timeoutMs);
      this.#pending.set(key, {
        operation: command.type,
        ...("writeId" in command ? { writeId: command.writeId } : { requestId: command.requestId }),
        resolve,
        reject,
        timeout,
      });
      try {
        send(command);
      } catch {
        clearTimeout(timeout);
        this.#pending.delete(key);
        reject(new Error("Could not send command to the Runner"));
      }
    }).then((report) => {
      if (!report.applied) {
        throw new ExecCommandRejected(report);
      }
      return report;
    });
  }

  report(report: Ack) {
    const operationId = report.writeId ?? report.requestId;
    if (operationId === undefined) return;
    const key = ackKey(report.operation, operationId);
    const pending = this.#pending.get(key);
    if (pending === undefined || pending.operation !== report.operation) return;
    if (pending.requestId !== report.requestId || pending.writeId !== report.writeId) return;
    this.#pending.delete(key);
    clearTimeout(pending.timeout);
    pending.resolve(report);
  }

  forget(command: ExecCommand) {
    const operationId = "writeId" in command ? command.writeId : command.requestId;
    const key = ackKey(command.type, operationId);
    const pending = this.#pending.get(key);
    if (pending === undefined) return;
    this.#pending.delete(key);
    clearTimeout(pending.timeout);
  }

  fail(error: Error) {
    for (const [key, pending] of this.#pending) {
      this.#pending.delete(key);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }
}
