import { describe, expect, it } from "vite-plus/test";

import { groupConnectedServices } from "./connectedServices.ts";

const personal = { id: "aid_personal", label: "alex@example.com" };
const work = { id: "aid_work", label: "alex@company.example" };

describe("groupConnectedServices", () => {
  it("lists one verified account once, with every app it's connected to", () => {
    expect(
      groupConnectedServices([
        { integration: "gmail", name: "personal", account: personal },
        { integration: "google_drive", name: "personal", account: personal },
        { integration: "google_photos", name: "personal", account: personal },
      ]),
    ).toEqual([
      {
        key: "account:aid_personal",
        label: "alex@example.com",
        verified: true,
        apps: [
          {
            integration: "gmail",
            label: "Gmail",
            domain: "mail.google.com",
            connection: "personal",
          },
          {
            integration: "google_drive",
            label: "Google Drive",
            domain: "drive.google.com",
            connection: "personal",
          },
          {
            integration: "google_photos",
            label: "Google Photos",
            domain: "photos.google.com",
            connection: "personal",
          },
        ],
      },
    ]);
  });

  it("keeps two accounts that connect the same app as separate rows", () => {
    const groups = groupConnectedServices([
      { integration: "gmail", name: "home", account: personal },
      { integration: "gmail", name: "work", account: work },
      { integration: "google_calendar", name: "home", account: personal },
    ]);
    expect(groups.map((group) => [group.label, group.apps.map((app) => app.connection)])).toEqual([
      ["alex@example.com", ["home", "home"]],
      ["alex@company.example", ["work"]],
    ]);
  });

  it("never merges unverified connections, even when their names match", () => {
    const groups = groupConnectedServices([
      { integration: "gmail", name: "me" },
      { integration: "google_drive", name: "me" },
      { integration: "gmail", name: "me2", account: personal },
    ]);
    expect(groups.map(({ key, label, verified }) => ({ key, label, verified }))).toEqual([
      { key: "connection:gmail/me", label: "me", verified: false },
      { key: "connection:google_drive/me", label: "me", verified: false },
      { key: "account:aid_personal", label: "alex@example.com", verified: true },
    ]);
  });

  it("names Executor's integrations the way people know them", () => {
    expect(
      groupConnectedServices([
        { integration: "todoist_com", name: "me" },
        { integration: "spotify_web_api", name: "me" },
      ]).map((group) => group.apps[0]),
    ).toEqual([
      { integration: "todoist_com", label: "Todoist", domain: "todoist.com", connection: "me" },
      { integration: "spotify_web_api", label: "Spotify", domain: "spotify.com", connection: "me" },
    ]);
  });
});
