import { describe, expect, it } from "vite-plus/test";
import { createCliTraceLog } from "../../harness/ClaudeCliTraceLog.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

describe("Computer's CLI trace log", () => {
  it("stays bounded across many short sessions on one database", () => {
    const owned = createTestFilesystem();
    try {
      for (let session = 0; session < 300; session++) {
        const write = createCliTraceLog(owned.storage, () => session);
        for (let event = 0; event < 6; event++) write("cli", { kind: "dropped", count: event });
      }
      const [count] = owned.storage.sql.exec("SELECT COUNT(*) AS rows FROM harness_cli_trace");
      const [newest] = owned.storage.sql.exec("SELECT MAX(at) AS at FROM harness_cli_trace");
      expect(Number(count?.rows)).toBeLessThanOrEqual(1_100);
      expect(Number(newest?.at)).toBe(299);
    } finally {
      owned.close();
    }
  });
});
