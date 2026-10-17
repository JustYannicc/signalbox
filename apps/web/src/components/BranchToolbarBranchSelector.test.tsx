import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type ServerConfig } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  configAtom: null as unknown,
  listRefsQueries: [] as (string | null)[],
}));

vi.mock("../state/server", () => ({
  serverEnvironment: { configValueAtom: () => state.configAtom },
}));
vi.mock("../state/vcs", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const status = Atom.make(AsyncResult.initial(false));
  const refs = Atom.family((query: string | null) =>
    Atom.make(() => {
      state.listRefsQueries.push(query);
      return AsyncResult.success({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }),
  );
  return {
    vcsEnvironment: {
      status: () => status,
      listRefs: ({ input }: { input: { cwd: string; query?: string | null } }) =>
        refs(input.query ?? null),
    },
  };
});
vi.mock("../state/entities", () => ({
  useThreadShell: () => ({
    id: "thread-test",
    environmentId: "environment-test",
    projectId: "project-test",
    branch: "main",
    worktreePath: null,
    runtime: null,
    linkedPullRequest: null,
    pullRequests: [],
    branchPullRequest: null,
  }),
  useProject: () => ({ id: "project-test", workspaceRoot: "/repo" }),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      getDraftSession: () => null,
      getDraftThreadByRef: () => null,
      setDraftThreadContext: () => {},
    }),
}));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: { stopSession: "stopSession", updateMetadata: "updateMetadata" },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./chat/composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("./BranchPicker", () => ({ BranchPicker: () => null, BranchPickerRefItem: () => null }));
vi.mock("../hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("./ThreadStatusIndicators", () => ({
  prStatusIndicator: () => null,
  resolveThreadPullRequestBadge: () => null,
  useLinkedThreadPullRequest: () => null,
}));
vi.mock("../lib/openPullRequestLink", () => ({ useOpenPrLink: () => () => {} }));

import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

function environmentConfig(capabilities: { readonly worktrees?: boolean }): ServerConfig {
  // The selector reads only the environment capability from this config.
  return { environment: { capabilities } } as unknown as ServerConfig;
}

it("waits for config before loading refs and keeps the self-hosted default", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const environmentId = EnvironmentId.make("environment-test");
  const configAtom = Atom.make<ServerConfig | null>(null);
  const registry = AtomRegistry.make();
  state.configAtom = configAtom;
  state.listRefsQueries.length = 0;
  registry.set(configAtom, null);
  let renderer: ReactTestRenderer | null = null;

  const selector = (
    <RegistryContext.Provider value={registry}>
      <BranchToolbarBranchSelector
        environmentId={environmentId}
        threadId={ThreadId.make("thread-test")}
        envLocked={false}
        startFromOrigin={false}
        onStartFromOriginChange={() => {}}
        displayMode="panel"
      />
    </RegistryContext.Provider>
  );

  try {
    await act(async () => {
      renderer = create(selector);
    });
    expect(state.listRefsQueries).toEqual([]);

    await act(async () => {
      registry.set(configAtom, environmentConfig({ worktrees: false }));
    });
    expect(state.listRefsQueries).toEqual([]);

    await act(async () => {
      registry.set(configAtom, environmentConfig({}));
    });
    expect(state.listRefsQueries).toEqual(expect.arrayContaining([null, "main"]));
    expect(state.listRefsQueries).toHaveLength(2);
  } finally {
    await act(async () => renderer?.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
  }
});
