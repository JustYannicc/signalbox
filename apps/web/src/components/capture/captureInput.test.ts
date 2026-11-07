import { describe, expect, it } from "vite-plus/test";
import type { CaptureDestination } from "@t3tools/client-runtime/capture/destinations";
import {
  EnvironmentId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import {
  captureDefaultDestination,
  captureDestinationAvailable,
  selectCaptureFiles,
} from "./captureInput";

const first: CaptureDestination = {
  key: "account-one:home",
  environmentId: EnvironmentId.make("environment"),
  ownerProjectId: ProjectId.make("account-one"),
  folderId: null,
  label: "Top level",
  detail: null,
  inPlace: "at the top level",
};
const second = { ...first, key: "account-two:home", ownerProjectId: ProjectId.make("account-two") };

describe("capture input", () => {
  it("waits for its first destination and keeps it across sign-out and account changes", () => {
    expect(captureDefaultDestination(null, [])).toBeNull();
    const selected = captureDefaultDestination(null, [first]);
    expect(selected).toBe(first);
    expect(captureDefaultDestination(selected, [])).toBe(first);
    expect(captureDefaultDestination(selected, [second])).toBe(first);
    expect(captureDestinationAvailable(selected, [])).toBe(false);
    expect(captureDestinationAvailable(selected, [second])).toBe(false);
    expect(captureDestinationAvailable(selected, [first])).toBe(true);
  });

  it("does not accept a null destination or the same key reassigned to another owner", () => {
    expect(captureDestinationAvailable(null, [first])).toBe(false);
    expect(captureDestinationAvailable(first, [{ ...second, key: first.key }])).toBe(false);
  });

  it("rejects empty and oversized files before they consume attachment slots", () => {
    const empty = { name: "empty.txt", size: 0 };
    const oversized = { name: "large.mov", size: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 };
    const maximum = { name: "allowed.mov", size: PROVIDER_SEND_TURN_MAX_FILE_BYTES };
    const result = selectCaptureFiles(
      [empty, oversized, maximum],
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
    );
    expect(result.files).toEqual([maximum]);
    expect(result.message).toContain("empty.txt is empty");
    expect(result.message).toContain("large.mov is too large");
  });

  it("keeps the existing attachment cap after size validation", () => {
    const a = { name: "a.txt", size: 1 };
    const b = { name: "b.txt", size: 2 };
    const result = selectCaptureFiles([a, b], PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1);
    expect(result.files).toEqual([a]);
    expect(result.message).toContain(`up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files`);
  });
});
