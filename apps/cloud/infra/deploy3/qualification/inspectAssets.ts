import { inventoryDeploymentAssets } from "../../harnessReleases/deploymentAssets.ts";
import { directoryHarnessArtifactStore } from "../../harnessReleases/publishArtifact.ts";
import { loadDeploy3ClaudeAssets } from "./claudeAssets.ts";

/** The caller supplies the final combined Worker root, including web and program assets. */
export async function inspectDeploy3AssetRoot(
  root: string,
  input: unknown,
  plan: "free" | "paid" = "free",
) {
  const inventory = await inventoryDeploymentAssets(root, plan);
  const store = directoryHarnessArtifactStore(root);
  const binding = {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
        .slice(1)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      return new Response(Uint8Array.from(await store.read(path)).buffer);
    },
  };
  const loaded = await loadDeploy3ClaudeAssets(input, binding);
  return { inventory, loaded };
}
