import git from "isomorphic-git";
import type { FsClient } from "isomorphic-git";
import type { NodeGitRoute } from "./types.ts";
import { validateNodeGitHttpUrl } from "./routing.ts";

export class NodeGitRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeGitRouteError";
  }
}

export async function resolveFetchTarget(
  fs: FsClient,
  currentDirectory: string,
  route: Extract<NodeGitRoute, { readonly kind: "fetch" }>,
): Promise<{ readonly dir: string; readonly remote: string; readonly url: string }> {
  const dir = await git.findRoot({ fs, filepath: currentDirectory });
  const corsProxy = await git.getConfig({ fs, dir, path: "http.corsProxy" });
  if (typeof corsProxy === "string" && corsProxy.trim() !== "") {
    throw new NodeGitRouteError("configured http.corsProxy is not supported by the HTTP adapter");
  }

  const branch = route.remote === undefined ? await git.currentBranch({ fs, dir }) : undefined;
  const trackingRemote =
    branch === undefined
      ? undefined
      : await git.getConfig({ fs, dir, path: `branch.${branch}.remote` });
  const remote = route.remote ?? (typeof trackingRemote === "string" ? trackingRemote : "origin");
  if (remote.length === 0) throw new NodeGitRouteError("git fetch has no configured remote");

  const configuredUrl =
    route.url ?? (await git.getConfig({ fs, dir, path: `remote.${remote}.url` }));
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new NodeGitRouteError(`git fetch has no URL configured for remote ${remote}`);
  }
  const validated = validateNodeGitHttpUrl(configuredUrl);
  if (typeof validated !== "string") throw new NodeGitRouteError(validated.message);
  return { dir, remote, url: validated };
}
