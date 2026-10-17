import { type CommandType, type DerivedReach, exempt, type ExemptReach, write } from "./reach.ts";

const internal = (reason: string) => exempt("internal", reason);
const delegation = internal(
  "An agent's delegation machinery; agents reach it through their own tools.",
);
const runner = internal("Reported by the machine preparing a run.");

/**
 * Each client-dispatchable `dispatchCommand` command as its own operation. The
 * operation's input is the command without `type`; `commandId` is optional and
 * filled in when missing.
 */
export const COMMAND_REACH = {
  "thread.create": internal(
    "Creates a parent run's child thread; people start threads with threads.create.",
  ),
  "thread.ask.raise": write({
    name: "threads.asks.raise",
    summary: "Raise a durable Blocker, Ready or Considering ask.",
  }),
  "thread.ask.answer": write({
    name: "threads.asks.answer",
    summary: "Answer part or all of an ask round.",
  }),
  "thread.ask.withdraw": write({
    name: "threads.asks.withdraw",
    summary: "Withdraw an ask that is no longer needed.",
  }),
  "thread.ask.sync": internal("The automation engine synchronizing its journaled ask."),
  "thread.archive": write(),
  "thread.unarchive": write(),
  "thread.delete": write({ destructive: true }),
  "thread.settle": write(),
  "thread.auto-settle": internal("Dispatched by the settlement sweep."),
  "thread.unsettle": write(),
  "thread.snooze": write(),
  "thread.unsnooze": write(),
  "thread.auto-settle.set": write(),
  "thread.pin": write(),
  "thread.unpin": write(),
  "thread.pin.reorder": write(),
  "thread.active.reorder": write(),
  "thread.visit": write({ name: "threads.markRead" }),
  "thread.mark-unread": write(),
  "thread.metadata.update": write({ name: "threads.update", summary: "Rename a thread." }),
  "thread.pull-request.link": write(),
  "thread.pull-request.unlink": write(),
  "thread.pull-request-link.sync": internal("Records what the server read from the host."),
  "thread.pull-request.watch": write(),
  "thread.pull-request.sync": internal("Records what the server read from the host."),
  "thread.title.regeneration.complete": internal("The server's title generator finishing."),
  "thread.runtime-mode.set": write(),
  "thread.interaction-mode.set": write(),
  "thread.model-selection.set": write(),
  "provider-session.detach": internal("The server letting go of a provider session."),
  "message.dispatch": write({
    name: "threads.send",
    summary: "Send a message to a thread; it starts a run or queues behind the active one.",
  }),
  "prepared-run.release": runner,
  "prepared-run.progress": runner,
  "prepared-run.fail": runner,
  "prepared-run.retry": write({ name: "threads.retryPreparation" }),
  "notification.delivery.accept": internal("A provider accepting a mailbox delivery."),
  "subagent.stop": write({ name: "threads.stopSubagent" }),
  "run.interrupt": write({ name: "threads.interrupt", summary: "Stop a thread's active run." }),
  "queued-message.promote-to-steer": write(),
  "queue.resume": write(),
  "queued-run.reorder": write(),
  "queued-run.cancel": write(),
  "queued-run.edit": write(),
  // Approvals and questions an agent asked are the person's (#335 decision 4).
  "runtime-request.respond": write({
    name: "threads.respond",
    humanOnly: true,
    summary: "Answer an approval or question a thread is waiting on.",
  }),
  "thread.user-input.dismiss": write({ name: "threads.dismissQuestion", humanOnly: true }),
  "checkpoint.rollback": write({ name: "threads.rollback", destructive: true }),
  "thread.fork": write(),
  "thread.merge_back": write({ name: "threads.mergeBack" }),
  "delegated_task.request": delegation,
  "delegated_task.wake-policy": delegation,
  "delegated_task.completion-delivery.acknowledge": delegation,
  "delegated_task.completion-delivery.dispose": delegation,
  "thread.created.record": internal("Records a child thread its parent created."),
  "provider.switch": write({ name: "threads.switchProvider" }),
} as const satisfies Record<CommandType, DerivedReach | ExemptReach>;
