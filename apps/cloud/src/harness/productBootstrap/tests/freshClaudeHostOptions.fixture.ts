import * as Effect from "effect/Effect";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import { createMemoryFilePersistencePorts } from "../../../kernel/MemoryFilePersistencePorts.ts";
import { createNodeFs } from "../../../isolate/NodeFs.ts";
import type { ProductClaudeHarnessHostOptions } from "../../ProductClaudeHarnessSessionHost.ts";
import {
  freshClaudeAdapterOptions,
  freshClaudeAdapterServices,
} from "./freshClaudeAdapter.fixture.ts";
import { freshClaudeTurnData } from "./freshClaudeTurn.fixture.ts";
import {
  freshClaudeSdkProcessPeer,
  type FreshClaudeGrant,
} from "./freshClaudeNativeHandoff.peer.fixture.ts";
import { programFixture, commandLoader } from "../../tests/productHost/commands.ts";
import { machineFixture } from "../../tests/productHost/machine.ts";
import { claudeReleaseVariantsForArtifact } from "../../tests/productHost/releaseVariants.fixture.ts";
import { hostSqlite } from "../../tests/hostSqlite.ts";
import { releaseSource } from "./artifacts.fixture.ts";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";

export const freshClaudeHostOptions = () =>
  Effect.gen(function* () {
    const source = yield* Effect.tryPromise({
      try: () => releaseSource("claude-code"),
      catch: (cause) => new HarnessRequestFacetError("Release fixture failed", { cause }),
    });
    const database = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (value) =>
      Effect.sync(() => value.dispose()),
    );
    const deps = yield* freshClaudeAdapterServices;
    const data = yield* freshClaudeTurnData();
    const programs = yield* Effect.promise(programFixture);
    const commands = commandLoader();
    const machine = machineFixture("turn", () => undefined);
    const capacity = new ChildWorkerCapacity(2, {
      RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
      owner: "test/fresh-claude-native-handoff",
    });
    const persistencePorts = createMemoryFilePersistencePorts();
    const persistenceAt = { repository: "fresh-claude-product", fork: "thread", commit: "base" };
    persistencePorts.seedFile(
      persistenceAt,
      "/workspace/file.txt",
      new TextEncoder().encode("before\n"),
    );
    const initialNativeMarker = "12345678-1234-4234-8234-123456789abc";
    const peer = freshClaudeSdkProcessPeer();
    const lifecycle: string[] = [];
    const turnGrantIssues: { readonly runId: string; readonly nativeTurnEpoch: number }[] = [];
    const executorGrants: string[] = [];
    const executorEndpoints: string[] = [];
    const modelRequests: string[] = [];
    let savedTurns = 0;
    const options: Omit<ProductClaudeHarnessHostOptions<FreshClaudeGrant>, "release"> = {
      threadId: data.threadId,
      releaseVariants: claudeReleaseVariantsForArtifact(source.artifact),
      continuations: { publish: () => Effect.die(new Error("Unexpected Claude continuation.")) },
      programs,
      machineInventory: machine.inventory,
      files: {
        identity: "fresh-claude-product-files",
        database: database.open().storage,
        nowNs: () => 0n,
        persistencePorts,
        rootMetadata: { mode: 0o755, uid: 1000, gid: 1000 },
        posix: {
          credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
          umask: 0o022,
        },
        cwd: "/workspace",
        assetMode: 0o644,
      },
      commands: {
        loader: commands.loader,
        orderedMachineRules: [],
        capacity,
        systemIdentity: data.systemIdentity,
        machine: () => machine.port,
      },
      save: async ({ files: currentFiles, persistence, signal }) => {
        const result = await persistence.commitTurn({
          at: persistenceAt,
          turnId: `fresh-claude-save-${++savedTurns}`,
          signal,
          changedInodes: [
            {
              inode: currentFiles.resolve("/workspace/file.txt").inode,
              paths: ["/workspace/file.txt"],
              removedPaths: [],
            },
          ],
        });
        if (result.status !== "ok") throw new Error(result.error.message);
        persistenceAt.commit = result.value.commit;
        return result.value;
      },
      port: async () => ({ fetch: async () => new Response("unused") }),
      hydrate: async ({ files: canonical }) => {
        const fs = createNodeFs(canonical).fs;
        fs.mkdirSync("/recorded/git", { recursive: true });
        fs.writeFileSync("/workspace/.git", "gitdir: /recorded/git\n");
        fs.writeFileSync("/workspace/file.txt", "before\n");
        fs.mkdirSync("/home/recorded", { recursive: true });
        fs.writeFileSync("/home/recorded/session", initialNativeMarker);
      },
      modelTransport: async (request) => {
        modelRequests.push(request.url);
        return new Response("unused model response");
      },
      executor: {
        forward: async ({ grant, gatewayEndpoint, request }) => {
          executorGrants.push(grant.token);
          executorEndpoints.push(gatewayEndpoint ?? "");
          if (request.method !== "POST" || (await request.text()) !== "mcp access probe")
            throw new Error("The SDK peer sent an invalid MCP access probe.");
          return new Response(`grant:${grant.token}`);
        },
      },
      turnGrantSource: {
        issue: async ({ runId, nativeTurnEpoch }) => {
          turnGrantIssues.push({ runId, nativeTurnEpoch });
          lifecycle.push(`turn-grant:${runId}`);
          return { grant: { token: `gateway-${runId}` }, endpoint: "https://gateway.product.test" };
        },
      },
      native: {
        harness: "claude-code",
        process: peer.process,
        loadSdk: peer.loadSdk,
        mcpSessions: deps.mcpSessions,
        adapter: (input) => {
          return Effect.succeed(
            freshClaudeAdapterOptions(input.harness.computer.files, deps, data.instanceId),
          );
        },
      },
    };
    return {
      source,
      data,
      options,
      peer,
      lifecycle,
      turnGrantIssues,
      executorGrants,
      executorEndpoints,
      modelRequests,
    };
  });
