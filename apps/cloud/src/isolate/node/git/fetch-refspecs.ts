import git from "isomorphic-git";
import type { NodeGitFsClient } from "./filesystem.ts";
import { NodeGitRouteError } from "./remote.ts";

export async function fetchExplicitRefs(
  options: Parameters<typeof git.fetch>[0] & { readonly fs: NodeGitFsClient },
  refspecs: readonly string[],
  fetchObjects: (options: Parameters<typeof git.fetch>[0]) => Promise<unknown>,
  autoTags = true,
): Promise<void> {
  const { fs, dir, remote = "origin", url, http, onAuth } = options;
  if (dir === undefined || url === undefined) throw new Error("Missing fetch target");
  const advertised = await git.listServerRefs({
    http,
    url,
    onAuth,
    protocolVersion: 1,
    symrefs: true,
    peelTags: true,
  });
  const configured = await git.getConfigAll({ fs, dir, path: `remote.${remote}.fetch` });
  const updates = new Map<string, { oid: string; force: boolean }>();
  const selected = [];
  const addUpdate = (ref: string, oid: string, force: boolean) => {
    validateRef(ref);
    const previous = updates.get(ref);
    if (previous !== undefined && previous.oid !== oid) {
      throw new Error(`Cannot fetch both different refs to ${ref}`);
    }
    updates.set(ref, { oid, force: force || previous?.force === true });
  };
  for (const refspec of refspecs) {
    const force = refspec.startsWith("+");
    const [source = "", destination] = refspec.replace(/^\+/, "").split(":");
    const candidates = new Set([
      source,
      `refs/${source}`,
      `refs/tags/${source}`,
      `refs/heads/${source}`,
      `refs/remotes/${source}`,
    ]);
    const matches = advertised.filter(({ ref }) => candidates.has(ref));
    if (matches.length === 0) throw new Error(`couldn't find remote ref ${source}`);
    if (matches.length > 1) throw new Error(`refspec ${source} matches more than one`);
    const match = matches[0]!;
    const localRefs = [match.ref];
    selected.push({ ...match, localRefs });
    if (destination) {
      const ref = destination.startsWith("refs/")
        ? destination
        : `${match.ref.startsWith("refs/tags/") ? "refs/tags/" : "refs/heads/"}${destination}`;
      addUpdate(ref, match.oid, force);
      localRefs.unshift(ref);
    }
    if (options.remote !== undefined) {
      for (const mapping of configured) {
        const target = mapConfiguredRef(mapping, match.ref);
        if (target !== undefined) {
          addUpdate(target, match.oid, mapping.startsWith("+"));
          localRefs.unshift(target);
        }
      }
    }
  }

  const currentBranch = await git.currentBranch({ fs, dir, fullname: true });
  if (currentBranch !== undefined && updates.has(currentBranch)) {
    throw new NodeGitRouteError(
      `refusing to fetch into branch '${currentBranch}' checked out at '${dir}'`,
      128,
    );
  }

  // The library fetches one ref and publishes configured mappings itself. Request the
  // advertised OID against a private config so only this adapter publishes the selected refs.
  const objectFs: NodeGitFsClient = {
    promises: {
      ...fs.promises,
      readFile: async (...[path, ...args]: Parameters<typeof fs.promises.readFile>) =>
        String(path) === `${dir}/.git/config`
          ? '[remote "origin"]\nfetch = +refs/heads/*:refs/remotes/origin/*\n'
          : fs.promises.readFile(path, ...args),
    },
  };
  for (const oid of new Set(selected.map(({ oid }) => oid))) {
    const localRefs = selected.filter((ref) => ref.oid === oid).flatMap((ref) => ref.localRefs);
    const ref = await findLocalHaveRef(fs, dir, localRefs);
    await fetchObjects({
      ...options,
      fs: objectFs,
      remote: "origin",
      remoteRef: oid,
      ...(ref === undefined ? {} : { ref }),
      singleBranch: true,
      tags: false,
      prune: false,
    });
  }
  const followTags = autoTags && refspecs.some((spec) => (spec.split(":")[1]?.length ?? 0) > 0);
  for (const tag of advertised.filter(({ ref }) => ref.startsWith("refs/tags/"))) {
    if (await git.resolveRef({ fs, dir, ref: tag.ref }).catch(() => undefined)) continue;
    if (!options.tags && !followTags) continue;
    const reachable = await git.readObject({ fs, dir, oid: tag.peeled ?? tag.oid }).then(
      () => true,
      () => false,
    );
    if (!options.tags && !reachable) continue;
    if ((await findLocalHaveRef(fs, dir, [tag.oid])) === undefined) {
      await fetchObjects({
        ...options,
        fs: objectFs,
        remote: "origin",
        remoteRef: tag.oid,
        ...(reachable ? { ref: tag.peeled ?? tag.oid } : {}),
        singleBranch: true,
        tags: false,
        prune: false,
      });
    }
    updates.set(tag.ref, { oid: tag.oid, force: false });
  }
  let rejected: NodeGitRouteError | undefined;
  for (const [ref, { oid, force }] of updates) {
    const existing = await git.resolveRef({ fs, dir, ref }).catch(() => undefined);
    if (existing !== undefined && existing !== oid && !force) {
      if (ref.startsWith("refs/tags/")) {
        rejected = new NodeGitRouteError(`would clobber existing tag ${ref}`, 1);
        continue;
      }
      if (
        ref.startsWith("refs/heads/") &&
        !(await git.isDescendent({ fs, dir, oid, ancestor: existing }))
      ) {
        rejected = new NodeGitRouteError(`non-fast-forward update rejected for ${ref}`, 1);
        continue;
      }
    }
    await git.writeRef({ fs, dir, ref, value: oid, force: true });
  }
  if (rejected !== undefined) throw rejected;
}

async function findLocalHaveRef(fs: NodeGitFsClient, dir: string, refs: readonly string[]) {
  // singleBranch uses only `ref` for haves. A bare branch name misses objects
  // held solely by its remote-tracking ref, causing a full-history transfer.
  for (const ref of refs) {
    try {
      const oid = await git.resolveRef({ fs, dir, ref });
      await git.readObject({ fs, dir, oid });
      return ref;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "NotFoundError"))
        throw error;
    }
  }
  return undefined;
}

function mapConfiguredRef(mapping: string, source: string): string | undefined {
  if (mapping.startsWith("^"))
    throw new NodeGitRouteError(
      `git fetch configured negative refspec is not supported: ${mapping}`,
    );
  const [from = "", to] = mapping.replace(/^\+/, "").split(":");
  if (!to) return undefined;
  const star = from.indexOf("*");
  if (star === -1) return from === source ? to : undefined;
  const prefix = from.slice(0, star);
  const suffix = from.slice(star + 1);
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) return undefined;
  return to.replace("*", source.slice(prefix.length, source.length - suffix.length));
}

function validateRef(ref: string): void {
  if (
    [...ref].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
    /[~^:?*\\[]/.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.endsWith(".") ||
    ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error(`invalid refspec destination '${ref}'`);
  }
}
