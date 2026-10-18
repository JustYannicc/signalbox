import { describe, expect, it } from "vite-plus/test";

import { tableErrorToSyncFailure } from "@signalbox/sync/definition";
import { TableReadError, TableWriteError } from "@signalbox/sync/table";

describe("table error recovery", () => {
  it("distinguishes permanent row conflicts from unavailable storage", () => {
    const conflict = new TableWriteError({ table: "items", reason: "key_conflict" });
    const unavailable = new TableWriteError({ table: "items", reason: "storage_unavailable" });
    expect(tableErrorToSyncFailure(conflict).reason).toBe("invalid_state");
    expect(tableErrorToSyncFailure(unavailable).reason).toBe("unavailable");
  });

  it("distinguishes invalid supplied rows from corrupt stored rows", () => {
    const input = new TableWriteError({ table: "items", reason: "invalid_row" });
    const stored = new TableReadError({ table: "items", reason: "invalid_row" });
    expect(tableErrorToSyncFailure(input).reason).toBe("invalid_input");
    expect(tableErrorToSyncFailure(stored).reason).toBe("storage_corrupt");
  });

  it("keeps cursor recovery separate from invalid query input", () => {
    const cursor = new TableReadError({ table: "items", reason: "invalid_cursor" });
    const query = new TableReadError({ table: "items", reason: "invalid_query" });
    expect(tableErrorToSyncFailure(cursor).reason).toBe("invalid_cursor");
    expect(tableErrorToSyncFailure(query).reason).toBe("invalid_input");
  });
});
