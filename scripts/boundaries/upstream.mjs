import vendoredRoots from "./vendored-roots.json" with { type: "json" };

export function readUpstreamSource(git, ref, head = "HEAD") {
  // Use the upstream history already merged here, so later deletions cannot change ownership.
  const commit = git(["merge-base", head, ref]);
  const files = new Set(git(["ls-tree", "-r", "--name-only", commit]).split("\n"));
  return { commit, files };
}

// Exclude only pinned source and generated copies; adapters remain fork-owned.
export const VENDORED_ROOTS = vendoredRoots;

export function sourceOwnership(upstream, file) {
  if (VENDORED_ROOTS.some((root) => file.startsWith(root))) return "vendored";
  return upstream.files.has(file) ? "upstream" : "fork";
}
