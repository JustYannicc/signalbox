import * as NodeAssert from "node:assert/strict";
import * as TestCase from "vite-plus/test";
import { controlBody, controlDigest, reconcileDeploy3Controls } from "./controlRegistry.ts";
import { controlFixture, controlRegistration } from "./control.fixture.ts";
import { releaseDeploy3Owner } from "./controlLifecycle.ts";

TestCase.test(
  "concurrent independent owner releases persist without overwriting each other",
  async () => {
    const fixture = controlFixture();
    await Promise.all(
      ["1070", "1255"].map((owner) =>
        releaseDeploy3Owner({
          api: fixture.api(owner === "1255" ? "owner1255" : "owner1070"),
          runId: "deadbeef",
          owner: owner === "1255" ? "1255" : "1070",
          async verifyLocalExportAndExplicitRelease() {
            return {
              verifiedLocalExportSha256: "a".repeat(64),
              explicitReleaseSha256: "b".repeat(64),
            };
          },
        }),
      ),
    );
    NodeAssert.deepEqual((await fixture.api().read()).controls[0]?.ownersNotReleased, []);
    NodeAssert.equal(fixture.comments.length, 3);
  },
);

TestCase.test(
  "failed local verification publishes no release, and a different owner cannot release it",
  async () => {
    const fixture = controlFixture();
    await NodeAssert.rejects(
      releaseDeploy3Owner({
        api: fixture.api(),
        runId: "deadbeef",
        owner: "1070",
        async verifyLocalExportAndExplicitRelease() {
          throw new Error("bad local blob");
        },
      }),
      /bad local blob/,
    );
    NodeAssert.equal(fixture.comments.length, 1);
    const sha = await controlDigest(controlBody(controlRegistration));
    fixture.comments.push({
      id: 2,
      user: { id: 102 },
      body: controlBody({
        kind: "released",
        runId: "deadbeef",
        registrationSha256: sha,
        owner: "1070",
        verifiedLocalExportSha256: "a".repeat(64),
        explicitReleaseSha256: "b".repeat(64),
      }),
    });
    await NodeAssert.rejects(fixture.api().read(), /Owner release writer differs/);
  },
);

TestCase.test(
  "untrusted comments have no authority and conflicting registrations fail closed",
  async () => {
    const fixture = controlFixture();
    const fake = { id: 2, user: { id: 999 }, body: fixture.comments[0]!.body };
    NodeAssert.equal(
      (await reconcileDeploy3Controls([...fixture.comments, fake], [101, 102])).length,
      1,
    );
    await NodeAssert.rejects(
      reconcileDeploy3Controls([...fixture.comments, { ...fake, user: { id: 101 } }], [101, 102]),
      /Conflicting deployment/,
    );
  },
);

TestCase.test(
  "an initial registration cannot smuggle an extension into its 24-hour deadline",
  () => {
    NodeAssert.throws(
      () =>
        controlBody({
          ...controlRegistration,
          deadlineUtc: "2026-10-30T13:00:03.456Z",
          cleanupTokenExpiresOn: "2026-10-30T15:00:03.456Z",
        }),
      /Invalid deployment control identity/,
    );
  },
);
