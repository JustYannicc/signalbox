import { describe, expect, it } from "vite-plus/test";

import { extractAgentNotificationDeepLink } from "../agent-awareness/notificationPayload";

const tap = (data: Record<string, unknown>) => ({
  notification: { request: { identifier: "n", content: { data } } },
});

describe("automation notification taps", () => {
  it("open the run the push names", () => {
    expect(
      extractAgentNotificationDeepLink(
        tap({ environmentId: "env-1", threadId: "", deepLink: "/automations/env-1/runs/run_1" }),
      ),
    ).toBe("/automations/env-1/runs/run_1");
  });

  it("re-encode ids and refuse other automation paths", () => {
    expect(
      extractAgentNotificationDeepLink(tap({ deepLink: "/automations/env%201/runs/run_1" })),
    ).toBe("/automations/env%201/runs/run_1");
    for (const deepLink of [
      "/automations/env-1/run_1",
      "/automations/env-1/runs/run_1/steps/s1",
      "/automations/env-1/runs/run_1?x=1",
      "/automations//runs/run_1",
    ]) {
      expect(
        extractAgentNotificationDeepLink(tap({ environmentId: "env-1", threadId: "", deepLink })),
      ).toBeNull();
    }
  });
});
