import { RunAttemptId, RunId, ThreadId } from "@t3tools/contracts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import type { StandardHarnessHookPorts } from "../../src/hooks/StandardHarnessHooks.ts";
import type {
  ThreadHarnessActiveAttempt,
  ThreadHarnessHookContext,
} from "../../src/hooks/ThreadHarnessHooks.ts";

const POOL = "proof-resolved-pool";
const MODEL = "proof-small-model";
export const STANDARD_PROOF_STATUS_NOTE = {
  nextStep: "Check the saved result",
  progress: "The tool turn finished",
};
const NOTE = STANDARD_PROOF_STATUS_NOTE;

export interface StandardProofModelRequest {
  readonly poolId: string;
  readonly model: string;
  readonly attempt: string;
}

/** Stateful restart-module test adapters. The model response is a fixture, like the tool model. */
export function createStandardProofState(
  storage: FacetStorage,
  scope: string,
  complete: (
    request: StandardProofModelRequest,
    signal: AbortSignal,
  ) => Promise<typeof NOTE> = async () => NOTE,
) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS proof_standard_attempts (
    scope TEXT PRIMARY KEY, generation INTEGER NOT NULL
  )`);
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS proof_standard_effects (
    attempt TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (attempt, kind)
  )`);
  const generation = storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO proof_standard_attempts VALUES (?, 1)
       ON CONFLICT(scope) DO UPDATE SET generation = generation + 1`,
      scope,
    );
    const row = [
      ...storage.sql.exec("SELECT generation FROM proof_standard_attempts WHERE scope = ?", scope),
    ][0];
    if (typeof row?.generation !== "number") throw new Error("Missing proof attempt generation");
    return row.generation;
  });
  const threadId = ThreadId.make(`thread:${scope}`);
  const attempt: ThreadHarnessActiveAttempt = Object.freeze({
    threadId,
    runId: RunId.make(`run:${scope}`),
    attemptId: RunAttemptId.make(`attempt:${scope}:${generation}`),
    generation,
  });
  const key = `${attempt.threadId}/${attempt.runId}/${attempt.attemptId}/${generation}`;
  let active: ThreadHarnessActiveAttempt | null = attempt;

  function assertAttempt(signal: AbortSignal, supplied: ThreadHarnessActiveAttempt | null) {
    signal.throwIfAborted();
    const row = [
      ...storage.sql.exec("SELECT generation FROM proof_standard_attempts WHERE scope = ?", scope),
    ][0];
    if (
      active === null ||
      supplied === null ||
      supplied.threadId !== threadId ||
      supplied.runId !== attempt.runId ||
      supplied.attemptId !== attempt.attemptId ||
      supplied.generation !== generation ||
      row?.generation !== generation
    )
      throw new Error("Stale standard proof attempt");
  }

  function assertCurrent(context: ThreadHarnessHookContext) {
    if (context.authority.threadId !== threadId) throw new Error("Foreign standard proof thread");
    assertAttempt(context.signal, context.authority.activeAttempt);
  }

  const read = (kind: string) =>
    [
      ...storage.sql.exec(
        "SELECT data FROM proof_standard_effects WHERE attempt = ? AND kind = ?",
        key,
        kind,
      ),
    ][0]?.data;
  const put = (context: ThreadHarnessHookContext, kind: string, data: unknown) =>
    storage.transactionSync(() => {
      assertCurrent(context);
      storage.sql.exec(
        "INSERT OR IGNORE INTO proof_standard_effects VALUES (?, ?, ?)",
        key,
        kind,
        JSON.stringify(data),
      );
    });

  const thread: StandardHarnessHookPorts["thread"] = {
    async ensureTurnStatus(context) {
      assertCurrent(context);
      if (read("status") !== undefined) return;
      // The owning Thread adapter resolves the route before asking its model port.
      const request = { poolId: POOL, model: MODEL, attempt: key };
      put(context, "model-request", request);
      const note = await complete(request, context.signal);
      put(context, "status", note);
    },
  };
  const automations: StandardHarnessHookPorts["automations"] = {
    async turnSettled(context) {
      put(context, "turn-settled", { type: "thread.turn-settled", attempt: key });
    },
  };

  return {
    authority: { threadId, activeAttempt: () => active },
    thread,
    automations,
    assertCurrent,
    assertActive: (signal: AbortSignal) => assertAttempt(signal, attempt),
    close() {
      active = null;
    },
    inspect() {
      const rows = [
        ...storage.sql.exec(
          "SELECT kind, data FROM proof_standard_effects WHERE attempt = ? ORDER BY kind",
          key,
        ),
      ];
      const effects = Object.fromEntries(
        rows.map((row) => [
          String(row.kind),
          typeof row.data === "string" ? (JSON.parse(row.data) as unknown) : null,
        ]),
      );
      return {
        kind: "stateful-restart-module-test-adapters",
        generation,
        effects,
        model: { kind: "deterministic-test-adapter", poolId: POOL, model: MODEL },
        taskCompletion: "unchanged",
        ok:
          read("status") === JSON.stringify(NOTE) &&
          read("model-request") !== undefined &&
          read("turn-settled") !== undefined &&
          rows.length === 3,
      };
    },
  };
}
