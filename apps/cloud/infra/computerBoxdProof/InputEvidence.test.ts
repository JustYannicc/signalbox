import { describe, expect, it } from "vite-plus/test";
import { proofInputEvidence } from "./InputEvidence.ts";

const inputs = (source: string, sha256: string) => ({
  runner: { source, sha256 },
  executables: [{ path: "/bin/bash" as const, data: "", sha256: "pinned-bash" }],
});

describe("proof input evidence", () => {
  it("compares region-path variants while preserving both raw build identities", () => {
    const local = proofInputEvidence(
      inputs('//#region /local/store/runner.js\nconsole.log("雪");', "local-hash"),
    );
    const deployed = proofInputEvidence(
      inputs('//#region /ci/store/runner.js\nconsole.log("雪");', "deployed-hash"),
    );

    expect(local.runnerWithoutRegionCommentsSha256).toBe(
      deployed.runnerWithoutRegionCommentsSha256,
    );
    expect(local.runnerSha256).toBe("local-hash");
    expect(deployed.runnerSha256).toBe("deployed-hash");
    expect(local.runnerBytes).not.toBe(deployed.runnerBytes);
    expect(deployed.executableSha256s).toEqual(["pinned-bash"]);
  });

  it("keeps a changed command in the comparison even when region paths match", () => {
    const before = proofInputEvidence(
      inputs('//#region /store/runner.js\nconsole.log("before");', "before-hash"),
    );
    const after = proofInputEvidence(
      inputs('//#region /store/runner.js\nconsole.log("after");', "after-hash"),
    );
    expect(before.runnerWithoutRegionCommentsSha256).not.toBe(
      after.runnerWithoutRegionCommentsSha256,
    );
  });
});
