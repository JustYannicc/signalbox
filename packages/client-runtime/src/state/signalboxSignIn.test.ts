import { SIGN_IN_EVERYWHERE, type SignInGrant } from "@t3tools/contracts/signalboxSignIn";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { signInCheckShown } from "./signalboxSignIn.ts";

const grant = (site: string): SignInGrant => ({
  id: site,
  source: { _tag: "person" },
  site,
  grantedBy: "user_1",
  grantedAt: 0,
});

describe("Try a site", () => {
  it("names the host the person typed and the grant that answered", () => {
    expect(
      signInCheckShown(
        "https://accounts.example.com/login",
        AsyncResult.success({ _tag: "allowed", grant: grant("example.com") }),
      ),
    ).toEqual({
      text: "Agents sign in to accounts.example.com without asking: you allowed example.com.",
      failed: false,
    });
    expect(
      signInCheckShown(
        "booking.com",
        AsyncResult.success({ _tag: "allowed", grant: grant(SIGN_IN_EVERYWHERE) }),
      ),
    ).toMatchObject({
      text: "Agents sign in to booking.com without asking: you allowed every site.",
    });
    expect(
      signInCheckShown(
        "https://account.booking.com",
        AsyncResult.success({ _tag: "ask", site: "booking.com" }),
      ),
    ).toMatchObject({ text: "Agents ask you first: “Let agents sign in to booking.com?”" });
  });
});
