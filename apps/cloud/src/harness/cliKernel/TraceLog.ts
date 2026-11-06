import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import type { CliViewTrace } from "../CliViewTrace.ts";

const KEPT_ROWS = 1_000;
const MAX_EVENT_CHARS = 1_024;

/**
 * Computer's own record of what the CLI's view and the machine layer did. The thread's log only
 * takes lines of a handed-over turn, and a stall before or between turns is exactly what this
 * must show, so traces land here, in Computer's database, as they are produced.
 */
export function createCliTraceLog(database: FacetStorage, now: () => number) {
  database.sql.exec(
    "CREATE TABLE IF NOT EXISTS harness_cli_trace (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, event TEXT NOT NULL)",
  );
  let writes = 0;
  return (source: "cli" | "machine", event: CliViewTrace) => {
    const encoded = JSON.stringify(event);
    if (typeof event?.kind !== "string" || encoded.length > MAX_EVENT_CHARS) return;
    database.sql.exec(
      "INSERT INTO harness_cli_trace (at, source, event) VALUES (?, ?, ?)",
      now(),
      source,
      encoded,
    );
    // Keep the newest rows, so a long session can't grow the table without bound.
    if (++writes % 100 === 0)
      database.sql.exec(
        "DELETE FROM harness_cli_trace WHERE id <= (SELECT MAX(id) FROM harness_cli_trace) - ?",
        KEPT_ROWS,
      );
  };
}
