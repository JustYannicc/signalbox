import { describe, expect, it } from "vite-plus/test";

import { groupConnectedServices } from "./connectedServices.ts";

describe("groupConnectedServices", () => {
  it("groups accounts per integration and names them the way people know them", () => {
    expect(
      groupConnectedServices([
        { integration: "gmail", name: "home" },
        { integration: "gmail", name: "work" },
        { integration: "google_calendar", name: "personal" },
        { integration: "todoist_com", name: "me" },
        { integration: "spotify_web_api", name: "me" },
      ]),
    ).toEqual([
      {
        integration: "gmail",
        label: "Gmail",
        domain: "mail.google.com",
        accounts: ["home", "work"],
      },
      {
        integration: "google_calendar",
        label: "Google Calendar",
        domain: "calendar.google.com",
        accounts: ["personal"],
      },
      { integration: "todoist_com", label: "Todoist", domain: "todoist.com", accounts: ["me"] },
      { integration: "spotify_web_api", label: "Spotify", domain: "spotify.com", accounts: ["me"] },
    ]);
  });
});
