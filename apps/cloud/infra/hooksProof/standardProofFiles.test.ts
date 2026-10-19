import { describe, expect, it } from "vite-plus/test";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import { createProofFilesystemHost } from "../claudeTurnProof/proofFilesystem.ts";
import {
  createStandardProofAdapter,
  STANDARD_PROOF_WRITE,
  STANDARD_PROOF_FILLED_WRITE,
} from "./standardProofAdapter.ts";
import { installStandardProofFiles } from "./standardProofFiles.ts";

describe("standard proof file boundary", () => {
  it("fills the actual handle write, preserves its lifetime and rename, and leaves non-workspace writes alone", async () => {
    const database = createProofTestStorage();
    const host = createProofFilesystemHost(database.storage);
    const gateway = createStandardProofAdapter(database.storage, "files");
    const restore = installStandardProofFiles(host.fs, gateway);
    try {
      await gateway.callback(
        {
          harness: "claude-code",
          event: "pre-tool-use",
          sessionId: "native-session",
          payload: { hook_event_name: "PreToolUse" },
        },
        { signal: gateway.signal },
      );
      const directory = await host.fs["fs/promises"].open("/work", "r");
      const temporary = `/proc/self/fd/${directory.fd}/temporary`;
      const handle = await host.fs["fs/promises"].open(temporary, "w");
      const fd = handle.fd;
      await handle.writeFile(STANDARD_PROOF_WRITE, "utf8");
      expect(handle.fd).toBe(fd);
      expect((await handle.stat()).size).toBe(
        new TextEncoder().encode(STANDARD_PROOF_WRITE).length,
      );
      await handle.close();
      expect(handle.closed).toBe(true);
      await host.fs["fs/promises"].rename(temporary, "/work/official-write.txt");
      await directory.close();
      expect(host.fs.fs.readFileSync("/work/official-write.txt", "utf8")).toBe(
        STANDARD_PROOF_FILLED_WRITE,
      );
      await host.fs["fs/promises"].writeFile("/home/claude/placeholders", STANDARD_PROOF_WRITE);
      expect(host.fs.fs.readFileSync("/home/claude/placeholders", "utf8")).toBe(
        STANDARD_PROOF_WRITE,
      );
      expect(gateway.inspect().gateway.writes).toBe(1);
    } finally {
      restore();
      gateway.close();
      host.filesystem.dispose();
      host.wakes.dispose();
      database.close();
    }
  });
});
