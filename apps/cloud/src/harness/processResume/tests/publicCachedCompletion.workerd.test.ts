// @effect-diagnostics nodeBuiltinImport:off - this test runs the public C root in isolated local workerd.
import * as NodeURL from "node:url";
import * as NodeProcess from "node:process";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createPublicResumeHarness } from "./publicResumeHarness.fixture.ts";

let harness: Awaited<ReturnType<typeof createPublicResumeHarness>>;
beforeAll(async () => {
  harness = await createPublicResumeHarness({
    name: "public-c-cached-completion",
    main: NodeURL.fileURLToPath(
      new URL("./publicCachedCompletion.workerd.fixture.ts", import.meta.url),
    ),
    supervisorClass: "ReceiptCountingSupervisor",
  });
  await harness.listen();
}, 60_000);

afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
    NodeProcess.stdout.write("[public-C-harness-close-returned] cachedCompletion\n");
  }
});

it("returns an exact committed checkpoint receipt after C reconstruction without recommitting", async () => {
  const response = await harness.fetch("http://proof/cached-completion");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const result = JSON.parse(body);
  expect(result.reconstructedNonce).not.toBe(result.originalNonce);
  expect(result.recoveredReceipt).toEqual(result.originalReceipt);
  expect(result.beforeCount).toBe(1);
  expect(result.afterCount).toBe(result.beforeCount);
  expect(result.changedDenied).toBe(true);
  expect(result.afterCheckpoint).toEqual(result.beforeCheckpoint);
});
