import { describe, expect, it } from "vite-plus/test";
import { pipelineArtifactsAvailable, pipelineFixture } from "./TrPipelineFixture.ts";
import { exited } from "./ChildBashFixture.ts";

const captured = String.raw`for f in *.md; do printf '%s | ' "$f"; grep -m1 "^- State:" "$f" | tr -d '\n'; printf ' | '; grep -m1 "^- Blocked by:" "$f" | grep -o '\[[^]]*\]' | tr '\n' ' '; echo; done; grep -n -i "customer\|account" confirm-orders-consumer-contract-completeness.md | head`;
const files = {
  "a.md": "# A\n- State: Ready\n- Blocked by: [a] [b]\n",
  "b.md": "# B\n- State: Working\n- Blocked by: [a] [b]\n",
  "confirm-orders-consumer-contract-completeness.md":
    "# Customer account\n- State: Waiting\n- Blocked by: [a] [b]\n",
  f: "x\nx\n",
};

describe.skipIf(!pipelineArtifactsAvailable)("ProductComputer tr pipelines", () => {
  it.each([
    {
      script: captured,
      stdout:
        "a.md | - State: Ready | [a] [b] \nb.md | - State: Working | [a] [b] \nconfirm-orders-consumer-contract-completeness.md | - State: Waiting | [a] [b] \n1:# Customer account\n",
    },
    { script: String.raw`grep -m1 x f | tr -d '\n'; echo after`, stdout: "xafter\n" },
    { script: "yes | head -1; echo after", stdout: "y\nafter\n" },
  ])("continues after $script", async ({ script, stdout }) => {
    const fixture = pipelineFixture(files);
    try {
      expect(await fixture.run(script)).toEqual({ status: exited(), stdout, stderr: "" });
      expect(fixture.machineSpawn).not.toHaveBeenCalled();
      expect(fixture.signals).toEqual(
        script.startsWith("yes |") ? [{ executable: "/bin/yes", signal: 13 }] : [],
      );
      expect(fixture.commands.every(({ cwd }) => cwd === "/work")).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
