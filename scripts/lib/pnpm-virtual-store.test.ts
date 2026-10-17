// @effect-diagnostics nodeBuiltinImport:off - fixtures for build-tool filesystem visibility.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, test } from "vite-plus/test";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { pnpmViteFsAllow, pnpmVirtualStoreFolders } from "./pnpm-virtual-store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

test.skipIf(!symlinksSupported)(
  "Vite and Metro can see symlink targets in an external pnpm virtual store",
  () => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "metro-pnpm-")),
    );
    roots.push(root);
    const workspace = NodePath.join(root, "worktree");
    const modules = NodePath.join(workspace, "node_modules");
    const store = NodePath.join(root, "custom-store", "links");
    const react = NodePath.join(store, "react", "node_modules", "react");
    NodeFS.mkdirSync(react, { recursive: true });
    NodeFS.mkdirSync(modules, { recursive: true });
    NodeFS.symlinkSync(react, NodePath.join(modules, "react"), "dir");
    const target = NodeFS.realpathSync(NodePath.join(modules, "react"));
    for (const virtualStoreDir of [NodePath.relative(modules, store), store]) {
      NodeFS.writeFileSync(
        NodePath.join(modules, ".modules.yaml"),
        JSON.stringify({ virtualStoreDir }),
      );
      NodeAssert.equal(pnpmVirtualStoreFolders(workspace).length, 1);
      NodeAssert.deepEqual(pnpmViteFsAllow(NodePath.join(workspace, "apps", "web")), [
        workspace,
        store,
      ]);
      NodeAssert.ok(target.startsWith(pnpmVirtualStoreFolders(workspace)[0] + NodePath.sep));
    }
    NodeFS.writeFileSync(
      NodePath.join(modules, ".modules.yaml"),
      JSON.stringify({ virtualStoreDir: ".pnpm" }),
    );
    NodeAssert.deepEqual(pnpmVirtualStoreFolders(workspace), []);
    NodeAssert.deepEqual(pnpmViteFsAllow(NodePath.join(workspace, "apps", "web")), [workspace]);
  },
);
