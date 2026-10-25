import { describe, expect, it } from "vite-plus/test";
import { createNodeFs } from "../../src/isolate/NodeFs.ts";
import { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { canonicalFileByteSelection } from "../../src/kernel/KernelFileBytes.ts";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import { createProofFilesystemHost } from "../claudeTurnProof/proofFilesystem.ts";
import {
  createStandardProofAdapter,
  STANDARD_PROOF_WRITE,
  standardProofFilledWrite,
  STANDARD_PROOF_NAMED_SECRET,
  STANDARD_PROOF_VAULT_SECRET,
  scrubStandardProofRecord,
} from "./standardProofAdapter.ts";

describe("standard proof file boundary", () => {
  it("keeps a configured hook's JSON payload byte-for-byte in its command log", async () => {
    const database = createProofTestStorage();
    const host = createProofFilesystemHost(database.storage);
    const gateway = createStandardProofAdapter(
      database.storage,
      "hook-log",
      undefined,
      host.persistence.storage,
    );
    let commandFs: KernelFileSystem | undefined;
    try {
      await gateway.prepare();
      commandFs = host.filesystem.fork(host.filesystem.descriptors.fork([]), {
        fileBytes: canonicalFileByteSelection,
      });
      const inherited = gateway.selectFileBytes({
        executable: "/bin/cat",
        filesystem: commandFs,
        parent: { id: "configured-hook", kind: "process" },
      });
      expect(inherited).toEqual(canonicalFileByteSelection);
      commandFs.setFileBytes(inherited);
      const raw = createNodeFs(commandFs).fs;
      const payload = `${JSON.stringify({ tool_name: "Write", tool_input: { content: STANDARD_PROOF_WRITE } })}\n`;
      raw.appendFileSync("/work/hook-command-events.jsonl", payload);
      expect(host.fs.fs.readFileSync("/work/hook-command-events.jsonl", "utf8")).toBe(payload);
    } finally {
      commandFs?.dispose();
      gateway.close();
      host.filesystem.dispose();
      host.persistence.dispose();
      host.wakes.dispose();
      database.close();
    }
  });

  it("scrubs failed proof records after the active boundary has closed", () => {
    const record = scrubStandardProofRecord({
      ok: true,
      failure: `${STANDARD_PROOF_NAMED_SECRET.value} ${STANDARD_PROOF_VAULT_SECRET.value}`,
    });
    expect(record).toEqual({
      ok: false,
      failure: "{{secret:API_TOKEN}} {{secret:VAULT_TOKEN}}",
      recordBoundary: { unexpectedRawSecret: true },
    });
    expect(scrubStandardProofRecord({ ok: true, bytesRead: 42 })).toEqual({
      ok: true,
      bytesRead: 42,
      recordBoundary: { unexpectedRawSecret: false },
    });
  });

  it("selects raw command I/O while native writes, aliases and retained handles remain canonical", async () => {
    const database = createProofTestStorage();
    const host = createProofFilesystemHost(database.storage);
    const gateway = createStandardProofAdapter(
      database.storage,
      "files",
      undefined,
      host.persistence.storage,
    );
    let commandFs: KernelFileSystem | undefined;
    try {
      await gateway.prepare();
      const directory = await host.fs["fs/promises"].open("/work", "r");
      const temporary = `/proc/self/fd/${directory.fd}/temporary`;
      const handle = await host.fs["fs/promises"].open(temporary, "w+");
      await handle.writeFile(STANDARD_PROOF_WRITE, "utf8");
      expect((await handle.stat()).size).toBe(
        new TextEncoder().encode(STANDARD_PROOF_WRITE).length,
      );
      await handle.close();
      await host.fs["fs/promises"].rename(temporary, "/work/official-write.txt");
      await directory.close();
      expect(host.fs.fs.readFileSync("/work/official-write.txt", "utf8")).toBe(
        STANDARD_PROOF_WRITE,
      );

      const selection = gateway.selectFileBytes({
        executable: "/bin/cat",
        filesystem: host.filesystem,
      });
      commandFs = host.filesystem.fork(host.filesystem.descriptors.fork([]), {
        fileBytes: selection,
      });
      const raw = createNodeFs(commandFs).fs;
      expect(raw.readFileSync("/work/official-write.txt", "utf8")).toBe(standardProofFilledWrite());
      expect(raw.statSync("/work/official-write.txt").size).toBe(
        new TextEncoder().encode(standardProofFilledWrite()).length,
      );
      expect(gateway.selectFileBytes({ executable: "/bin/git", filesystem: commandFs })).toEqual({
        kind: "canonical",
      });
      expect(
        gateway.selectFileBytes({ executable: "/usr/bin/signalbox-hook", filesystem: commandFs }),
      ).toEqual({ kind: "canonical" });
      expect(gateway.inspect().gateway.files).toMatchObject([
        { bytesRead: new TextEncoder().encode(standardProofFilledWrite()).length },
      ]);
    } finally {
      commandFs?.dispose();
      gateway.close();
      host.filesystem.dispose();
      host.persistence.dispose();
      host.wakes.dispose();
      database.close();
    }
  });
});
