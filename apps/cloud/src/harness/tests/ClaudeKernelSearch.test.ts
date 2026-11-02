import { expect, it } from "vite-plus/test";
import { claudeKernelSearchTools, configureClaudeKernelSearch } from "../ClaudeKernelSearch.ts";

it("explicitly offers Grep alongside the full preset without adding an allow rule", () => {
  expect(claudeKernelSearchTools({ type: "preset", preset: "claude_code" })).toEqual([
    "preset:default",
    "Grep",
  ]);
});

it.each([{ tools: [] }, { tools: ["Read"] }, { tools: ["Read", "Grep"] }])(
  "preserves an explicit tool restriction: $tools",
  ({ tools }) => {
    expect(claudeKernelSearchTools(tools)).toBe(tools);
  },
);

it.each([undefined, "", "/usr/bin:/bin", "/custom:/bin:/bin:/usr/bin"])(
  "makes the kernel rg discoverable before other PATH entries: %j",
  (path) => {
    const env = { PATH: path, USE_BUILTIN_RIPGREP: "1", HOME: "/home/agent" };
    configureClaudeKernelSearch(env);
    expect(env.USE_BUILTIN_RIPGREP).toBe("0");
    expect(env.PATH?.split(":").filter((entry) => entry === "/bin")).toEqual(["/bin"]);
    expect(env.PATH?.split(":")[0]).toBe("/bin");
    expect(env.HOME).toBe("/home/agent");
  },
);
