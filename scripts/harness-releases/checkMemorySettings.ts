import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { CLAUDE_MEMORY_ENV, CODEX_MEMORY_CONFIG } from "@t3tools/contracts/harnessMemorySettings";
import { readExtraction } from "../claude-bunfs/extracted-input.ts";
import { assertClaudeMemorySettings } from "../claude-bunfs/memory-settings-claude.ts";
import { assertCodexMemorySettings } from "./codexMemorySettings.ts";

export async function checkClaudeMemorySettings(extracted: string) {
  const input = await readExtraction(extracted);
  const sources = new Map<string, string>();
  for (const module of input.manifest.modules) {
    if (module.loader === 1) sources.set(module.name, await input.readSource(module));
  }
  return assertClaudeMemorySettings(sources, CLAUDE_MEMORY_ENV);
}

async function main() {
  const [provider, root] = process.argv.slice(2);
  if (!root || (provider !== "claude-code" && provider !== "codex"))
    throw new Error("Usage: checkMemorySettings.ts claude-code|codex <package-source-directory>");
  const evidence =
    provider === "codex"
      ? await assertCodexMemorySettings(root, CODEX_MEMORY_CONFIG)
      : await checkClaudeMemorySettings(root);
  process.stdout.write(
    JSON.stringify({
      provider,
      pins: provider === "codex" ? CODEX_MEMORY_CONFIG : CLAUDE_MEMORY_ENV,
      evidence,
    }) + "\n",
  );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  await main();
}
