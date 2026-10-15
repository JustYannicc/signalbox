/**
 * Just enough of a Durable Object's state for the host: `storage.sql` over
 * `node:sqlite`, and an alarm the test fires by hand. Building a second host
 * over the same state is a redeploy: a new engine with nothing in memory.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const fakeObjectState = () => {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      const values = bindings.map((value) =>
        value === undefined ? null : value,
      ) as SQLInputValue[];
      if (statement.columns().length > 0) {
        const rows = statement.all(...values) as Record<string, unknown>[];
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
            return rows[0];
          },
          rowsWritten: 0,
        };
      }
      const info = statement.run(...values);
      return { toArray: () => [], one: () => undefined, rowsWritten: Number(info.changes) };
    },
  };
  const state = {
    storage: {
      sql,
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
      },
    },
  };
  return {
    state: state as unknown as DurableObjectState,
    db,
    alarmAt: () => alarm,
    clearAlarm: () => {
      alarm = null;
    },
    /** Moves every pending clock to now, as if the time had passed. */
    fastForwardClocks: () => {
      db.prepare("UPDATE wf_clocks SET wake_at = ?").run(Date.now() - 1);
    },
  };
};
