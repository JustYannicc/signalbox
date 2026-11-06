import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import type { CliViewTrace } from "../CliViewTrace.ts";

const KEPT_ROWS = 1_000;
const MAX_EVENT_CHARS = 1_024;
const PRUNE_EVERY = 100;

/**
 * Computer's own record of what the CLI's view and the machine layer did. The thread's log only
 * takes lines of a handed-over turn, and a stall before or between turns is exactly what this
 * must show, so traces land here, in Computer's database, as they are produced.
 */
export function createCliTraceLog(database: FacetStorage, now: () => number) {
  database.sql.exec(
    "CREATE TABLE IF NOT EXISTS harness_cli_trace (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, event TEXT NOT NULL)",
  );
  // The bound must hold across sessions, and most sessions write only a handful of rows.
  const prune = () =>
    database.sql.exec(
      "DELETE FROM harness_cli_trace WHERE id <= (SELECT MAX(id) FROM harness_cli_trace) - ?",
      KEPT_ROWS,
    );
  prune();
  return (source: "cli" | "machine", event: CliViewTrace) => {
    const encoded = JSON.stringify(event);
    if (typeof event?.kind !== "string" || encoded.length > MAX_EVENT_CHARS) return;
    const [row] = database.sql.exec(
      "INSERT INTO harness_cli_trace (at, source, event) VALUES (?, ?, ?) RETURNING id",
      now(),
      source,
      encoded,
    );
    if (Number(row?.id) % PRUNE_EVERY === 0) prune();
  };
}
