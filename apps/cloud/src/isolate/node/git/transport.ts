import git from "isomorphic-git";
import type {
  KernelAsyncProgramContext,
  KernelExitStatus,
} from "../../../kernel/KernelAsyncProgram.ts";
import { createGitFs, type NodeGitFsClient } from "./filesystem.ts";
import { awaitWithAbort, createGitHttpClient } from "./http-client.ts";
import { NodeGitRouteError, resolveFetchTarget } from "./remote.ts";
import type { NodeGitProgramOptions, NodeGitRoute } from "./types.ts";

const DEFAULT_TRANSFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_OBJECT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TOTAL_OBJECT_BYTES = 32 * 1024 * 1024;

const unsupportedEnvironment =
  /^(?:GIT_(?:DIR|WORK_TREE|CONFIG(?:_.+)?|SSH(?:_.+)?|HTTP(?:_.+)?|ASKPASS|SSL_NO_VERIFY|PROXY_COMMAND)|SSH_ASKPASS)$/;

interface PackBudgetOptions {
  readonly maxObjectBytes: number;
  readonly maxTotalObjectBytes: number;
}

export const runNodeGitHttpCommand = Object.freeze({
  async run(
    route: Exclude<NodeGitRoute, { readonly kind: "local" } | { readonly kind: "reject" }>,
    context: KernelAsyncProgramContext,
    options: NodeGitProgramOptions,
  ): Promise<KernelExitStatus> {
    const unsupportedEnv = Object.keys(context.env).find((name) =>
      unsupportedEnvironment.test(name),
    );
    if (unsupportedEnv !== undefined) {
      return this.fail(
        context,
        129,
        `git ${route.kind} does not support the ${unsupportedEnv} environment override`,
      );
    }

    const budgets = resolveBudgets(options);
    if ("error" in budgets) return this.fail(context, 129, budgets.error);

    try {
      for (const path of route.cwd) context.filesystem.chdir(path);
      const fs = createGitFs(context, route.kind === "clone" ? route.dir : undefined);
      const http = createGitHttpClient(
        options.fetch ?? globalThis.fetch,
        context.signal,
        budgets.maxTransferBytes,
      );
      try {
        const auth =
          options.onAuth === undefined
            ? undefined
            : (url: string, current: Parameters<NonNullable<NodeGitProgramOptions["onAuth"]>>[1]) =>
                awaitWithAbort(Promise.resolve(options.onAuth!(url, current)), context.signal);

        if (route.kind === "clone") {
          await withCloneGitDirectoryClaim(fs, route.dir, async () => {
            await cloneWithPackBudgets({
              fs,
              http: http.http,
              url: route.url,
              dir: route.dir,
              ...(route.depth === undefined ? {} : { depth: route.depth }),
              ...(route.ref === undefined ? {} : { ref: route.ref }),
              ...(route.singleBranch === undefined ? {} : { singleBranch: route.singleBranch }),
              noCheckout: route.noCheckout,
              noTags: route.noTags,
              ...(auth === undefined ? {} : { onAuth: auth }),
              maxObjectBytes: budgets.maxObjectBytes,
              maxTotalObjectBytes: budgets.maxTotalObjectBytes,
            });
          });
        } else {
          const target = await resolveFetchTarget(fs, context.filesystem.cwd, route);
          await fetchWithPackBudgets({
            fs,
            http: http.http,
            dir: target.dir,
            remote: target.remote,
            url: target.url,
            ...(route.depth === undefined ? {} : { depth: route.depth }),
            tags: route.tags,
            prune: route.prune,
            singleBranch: route.singleBranch,
            ...(auth === undefined ? {} : { onAuth: auth }),
            maxObjectBytes: budgets.maxObjectBytes,
            maxTotalObjectBytes: budgets.maxTotalObjectBytes,
          });
        }
        context.signal.throwIfAborted();
        return success();
      } finally {
        await http.dispose();
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return this.fail(context, error instanceof NodeGitRouteError ? 129 : 128, message);
    }
  },

  async fail(
    context: KernelAsyncProgramContext,
    exitCode: number,
    message: string,
  ): Promise<KernelExitStatus> {
    const descriptor = context.filesystem.descriptors.get(2);
    const write = descriptor.stdio?.write;
    if (write !== undefined) {
      await write.call(
        descriptor.stdio,
        new TextEncoder().encode(`fatal: ${message}\n`),
        descriptor.flags,
      );
    }
    return { exitCode, signal: 0, coreDumped: false };
  },
});

type CloneWithPackBudgets = Parameters<typeof git.clone>[0] & PackBudgetOptions;
type FetchWithPackBudgets = Parameters<typeof git.fetch>[0] & PackBudgetOptions;

const cloneWithPackBudgets = git.clone as (options: CloneWithPackBudgets) => Promise<void>;
const fetchWithPackBudgets = git.fetch as (options: FetchWithPackBudgets) => Promise<unknown>;

async function hasExistingEntries(fs: NodeGitFsClient, path: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(path);
    if (!stat.isDirectory()) return true;
    return (await fs.promises.readdir(path)).length > 0;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function withCloneGitDirectoryClaim<T>(
  fs: NodeGitFsClient,
  path: string,
  clone: () => Promise<T>,
): Promise<T> {
  if (await hasExistingEntries(fs, path)) {
    throw new Error(`destination path '${path}' already exists`);
  }
  await fs.promises.mkdir(path, { recursive: true });
  await fs.promises.mkdir(`${path}/.git`);
  return clone();
}

function resolveBudgets(options: NodeGitProgramOptions):
  | {
      readonly maxTransferBytes: number;
      readonly maxObjectBytes: number;
      readonly maxTotalObjectBytes: number;
    }
  | { readonly error: string } {
  const maxTransferBytes = options.maxTransferBytes ?? DEFAULT_TRANSFER_BYTES;
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_OBJECT_BYTES;
  const maxTotalObjectBytes = options.maxTotalObjectBytes ?? DEFAULT_TOTAL_OBJECT_BYTES;
  for (const [name, value] of Object.entries({
    maxTransferBytes,
    maxObjectBytes,
    maxTotalObjectBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return { error: `${name} must be a positive safe integer` };
    }
  }
  return { maxTransferBytes, maxObjectBytes, maxTotalObjectBytes };
}

function success(): KernelExitStatus {
  return { exitCode: 0, signal: 0, coreDumped: false };
}
