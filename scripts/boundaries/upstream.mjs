export function readUpstreamSource(git, ref) {
  // Use the upstream history already merged here, so later deletions cannot change ownership.
  const commit = git(["merge-base", "HEAD", ref]);
  const files = new Set(git(["ls-tree", "-r", "--name-only", commit]).split("\n"));
  return { commit, files };
}
