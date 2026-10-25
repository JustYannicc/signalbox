// @effect-diagnostics nodeBuiltinImport:off - Import hooks need a fresh Node process to test module linking.
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

it("loads host references without linking the Node-only SEA module", async () => {
  const output = await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      NodeProcess.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import { registerHooks } from "node:module";
          const getBuiltinModule = process.getBuiltinModule.bind(process);
          let seaReads = 0;
          process.getBuiltinModule = (name) => {
            if (name === "node:sea") seaReads++;
            return getBuiltinModule(name);
          };
          registerHooks({
            resolve(specifier, context, next) {
              if (specifier === "node:sea" || specifier === "sea")
                throw new Error('No such module "node:sea"');
              return next(specifier, context);
            },
          });
          const host = await import("@t3tools/shared/HostProcess");
          const Effect = await import("effect/Effect");
          assert.equal(Effect.runSync(host.Platform), process.platform);
          assert.equal(seaReads, 0);
          assert.equal(Effect.runSync(host.IsExecutable.pipe(Effect.provideService(host.IsExecutable, true))), true);
          assert.equal(seaReads, 0);
          assert.equal(Effect.runSync(host.IsExecutable), getBuiltinModule("node:sea").isSea());
          assert.equal(seaReads, 1);
          console.log("ok");
        `,
      ],
      { cwd: NodeURL.fileURLToPath(new URL("../", import.meta.url)) },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr, { cause: error }));
        else resolve(stdout);
      },
    );
  });
  expect(output.trim()).toBe("ok");
});
