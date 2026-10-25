import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { cruise } from "dependency-cruiser";

import config from "../../.dependency-cruiser.cjs";
import { cyclicViolations } from "./cycles.mjs";
import { readWorkspaces, workspaceAliases, workspaceViolations } from "./workspaces.mjs";

export async function scanGraph(root, files) {
  const previous = process.cwd();
  process.chdir(root);
  try {
    const workspaces = readWorkspaces(files);
    const inputs = files.filter(
      (file) =>
        /\.[cm]?[jt]sx?$/.test(file) &&
        !file.includes("/deps/") &&
        workspaces.some((workspace) => file.startsWith(`${workspace.directory}/`)) &&
        NodeFS.existsSync(file),
    );
    const { output } = await cruise(
      inputs,
      {
        ...config.options,
        validate: true,
        ruleSet: { forbidden: config.forbidden },
        outputType: "json",
      },
      {
        alias: { ...workspaceAliases(workspaces), "~": NodePath.join(root, "apps/web/src") },
        extensionAlias: {
          ".js": [".ts", ".tsx", ".js"],
          ".mjs": [".mts", ".mjs"],
          ".cjs": [".cts", ".cjs"],
        },
      },
    );
    const graph = typeof output === "string" ? JSON.parse(output) : output;
    if (
      !graph.modules.some((module) => module.source.endsWith(".ts") && module.dependencies.length)
    ) {
      throw new Error("No TypeScript dependencies were scanned.");
    }
    return {
      modules: graph.modules,
      violations: [
        ...graph.summary.violations,
        ...workspaceViolations(graph.modules, workspaces),
        ...cyclicViolations(graph.modules),
      ],
    };
  } finally {
    process.chdir(previous);
  }
}
