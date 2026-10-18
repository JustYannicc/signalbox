export function readUpstreamSource(git, ref, head = "HEAD") {
  // Use the upstream history already merged here, so later deletions cannot change ownership.
  const commit = git(["merge-base", head, ref]);
  const files = new Set(git(["ls-tree", "-r", "--name-only", commit]).split("\n"));
  return { commit, files };
}

// Nimbus stays byte-preserved at its recorded pin; Signalbox owns the adapters outside this root.
const VENDORED_ROOTS = ["apps/cloud/src/isolate/node/vm/vendor/"];

export function sourceOwnership(upstream, file) {
  if (VENDORED_ROOTS.some((root) => file.startsWith(root))) return "vendored";
  return upstream.files.has(file) ? "upstream" : "fork";
}
