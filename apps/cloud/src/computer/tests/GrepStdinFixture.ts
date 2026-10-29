export const grepInputLines = [
  "no match",
  "context: 雪",
  "SECTION name",
  "drive: root",
  "pool: shared",
  "member: alice",
  "org: example",
  "workos auth",
  "AUTH provider",
  "threadContexts",
  "UserSections",
  "UserPools",
  "ThreadEngine",
  "signalboxContexts",
  "signalboxDrives",
  "signalboxSections",
  "signalboxPools",
  "separator",
  "visibleTo: members",
  ...Array.from({ length: 12 }, (_, index) => `context ${index + 1}`),
  "after-context sentinel",
  "grants: read",
  "PoolRole: owner",
  "CREATE TABLE pools",
];
export const capturedGrepCases = [
  {
    commandId: 121,
    name: "case-insensitive domain terms",
    args: ["-iE", "context|section|drive|pool|member|org|workos|auth"],
    expected:
      grepInputLines
        .filter((line) => /context|section|drive|pool|member|org|workos|auth/i.test(line))
        .join("\n") + "\n",
  },
  {
    commandId: 145,
    name: "case-insensitive identifiers",
    args: [
      "-iE",
      "threadContexts|UserSections|UserPools|ThreadEngine|signalboxContexts|signalboxDrives|signalboxSections|signalboxPools",
    ],
    expected: grepInputLines.slice(9, 17).join("\n") + "\n",
  },
  {
    commandId: 168,
    name: "numbered trailing context",
    args: ["-n", "-A12", "visibleTo"],
    expected:
      "19:visibleTo: members\n" +
      grepInputLines
        .slice(19, 31)
        .map((line, index) => `${index + 20}-${line}\n`)
        .join(""),
  },
  {
    commandId: 211,
    name: "numbered extended pattern",
    args: ["-nE", "grants|PoolRole|CREATE TABLE"],
    expected: "33:grants: read\n34:PoolRole: owner\n35:CREATE TABLE pools\n",
  },
];
