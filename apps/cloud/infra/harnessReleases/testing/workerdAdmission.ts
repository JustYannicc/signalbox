import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { afterEach, beforeEach, vi } from "vite-plus/test";

export function useWorkerdAdmissionFixture() {
  let home: string | undefined;
  beforeEach(async () => {
    home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workerd-admission-fixture-"));
    const slot = NodePath.join(home, ".t3", "heavy-slots-native", "slot-1");
    await NodeFSP.mkdir(slot, { recursive: true });
    // The test and its inventory subprocesses share this live ancestor.
    await NodeFSP.writeFile(NodePath.join(slot, "pid"), `${NodeProcess.ppid}\n`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("HEAVY_SLOT_ACTIVE", "1");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (home !== undefined) await NodeFSP.rm(home, { recursive: true, force: true });
    home = undefined;
  });
}
