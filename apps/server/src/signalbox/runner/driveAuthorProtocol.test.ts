import { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

/**
 * A turn's commit author rides on its drive access, optional both ways, so a
 * cloud and its Runners can deploy in either order.
 */

/** DriveAccess as Runners before the author decode it. */
const OldDriveAccess = Schema.Struct({
  driveId: Schema.String,
  token: Schema.String,
  remoteToken: Schema.NullOr(Schema.String),
});
const decodeAccess = Schema.decodeUnknownSync(DriveAccess);
const encodeAccess = Schema.encodeSync(DriveAccess);
const decodeOldAccess = Schema.decodeUnknownSync(OldDriveAccess);

const access = { driveId: "my/personal/user_1", token: "sbd1.x.y", remoteToken: "sbr1.x.y" };
const author = { name: "Octo Cat", email: "1+octo@users.noreply.github.com" };

describe("a turn's commit author on the wire", () => {
  it("decodes drive access from a cloud that sends no author", () => {
    const decoded = decodeAccess(access);
    expect(decoded).toEqual(access);
    expect(decoded.author).toBeUndefined();
  });

  it("is ignored by a Runner that predates it", () => {
    const sent: unknown = JSON.parse(JSON.stringify(encodeAccess({ ...access, author })));
    expect(sent).toMatchObject({ author });
    expect(decodeOldAccess(sent)).toEqual(access);
  });
});
