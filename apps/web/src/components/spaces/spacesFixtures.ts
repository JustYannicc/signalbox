/**
 * PLACEHOLDER DATA. Spaces has no backend yet: these fixtures stand in for
 * what Executor-brokered sources (Drive, Notion, GitHub, Slack, Jira, ...)
 * will sync once they exist. Delete this file when the real read model lands.
 */

/** Home section ids that hold fixture data; a space is a section. */
export type SpaceId = "personal" | "work" | "work-northwind";
/** The connector behind a source; one connector can feed several spaces. */
export type SpacesConnector =
  | "notes"
  | "drive"
  | "photos"
  | "notion"
  | "github"
  | "gmail"
  | "raindrop"
  | "todoist"
  | "trello"
  | "slack"
  | "jira"
  | "confluence"
  | "sentry";
export type SpacesSyncState = "synced" | "syncing" | "error";
export type SpacesItemType =
  | "doc"
  | "sheet"
  | "slides"
  | "page"
  | "note"
  | "pdf"
  | "image"
  | "album"
  | "issue"
  | "task"
  | "message"
  | "email"
  | "link";

export type SpacesAccess = "read-write" | "read-only";

export interface SpacesSourceFixture {
  /** Unique across spaces; the same connector in two spaces gets two ids. */
  readonly id: string;
  readonly connector: SpacesConnector;
  readonly name: string;
  readonly space: SpaceId;
  readonly sync: SpacesSyncState;
  readonly lastSyncedAt: string;
  /** What Executor lets agents do through this source. */
  readonly access: SpacesAccess;
  readonly problem?: string;
}

export type SpacesPhotoTone = "primary" | "info" | "success" | "warning" | "muted" | "error";

export interface SpacesPhotoFixture {
  readonly name: string;
  readonly takenAt: string;
  readonly place: string;
  readonly tone: SpacesPhotoTone;
}

/** Just enough structure to draw a format-specific preview. */
export type SpacesPreviewFixture =
  | { readonly kind: "slides"; readonly slides: readonly string[] }
  | {
      readonly kind: "sheet";
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly kind: "pdf"; readonly pages: number }
  | {
      readonly kind: "album";
      readonly total: number;
      readonly photos: readonly SpacesPhotoFixture[];
    };

export interface SpacesItemFixture {
  readonly id: string;
  readonly name: string;
  readonly type: SpacesItemType;
  /** A source id from SPACES_SOURCES. */
  readonly source: string;
  /** Home section id; notes can live in any section. */
  readonly space: string;
  readonly location: string;
  readonly owner: string;
  readonly updatedAt: string;
  /** Chats and tasks that already pulled this item in as context. */
  readonly usedInChats: number;
  readonly pinned: boolean;
  readonly excerpt: string;
  readonly preview?: SpacesPreviewFixture;
  /** File path under the source folder when the name alone makes a bad one. */
  readonly file?: string;
  /** A pull request this item points at; opens on the Pull requests page. */
  readonly pullRequest?: { readonly repository: string; readonly number: number };
}

const MINUTE = 60_000;
const loadedAt = Date.now();
const ago = (minutes: number) => new Date(loadedAt - minutes * MINUTE).toISOString();
const HOUR = 60;
const DAY = 24 * HOUR;

const source = (
  id: string,
  connector: SpacesConnector,
  name: string,
  space: SpaceId,
  lastSyncedMinutes: number,
  access: SpacesAccess,
  sync: SpacesSyncState = "synced",
): SpacesSourceFixture => ({
  id,
  connector,
  name,
  space,
  sync,
  lastSyncedAt: ago(lastSyncedMinutes),
  access,
});

export const SPACES_SOURCES: readonly SpacesSourceFixture[] = [
  source("notes", "notes", "Notes", "personal", 0, "read-write"),
  source("notion", "notion", "Notion", "personal", 4, "read-write"),
  source("drive", "drive", "Google Drive", "personal", 12, "read-write"),
  source("photos", "photos", "Google Photos", "personal", 20, "read-only"),
  source("github", "github", "GitHub", "personal", 2, "read-write"),
  source("gmail", "gmail", "Gmail", "personal", 38, "read-only", "syncing"),
  source("raindrop", "raindrop", "Raindrop", "personal", HOUR, "read-write"),
  source("todoist", "todoist", "Todoist", "personal", 9, "read-write"),
  source("trello", "trello", "Trello", "personal", 3 * HOUR, "read-write"),
  source("work-notes", "notes", "Notes", "work", 0, "read-write"),
  source("northwind-notes", "notes", "Notes", "work-northwind", 0, "read-write"),
  source("northwind-drive", "drive", "Google Drive", "work-northwind", 7, "read-write"),
  source("slack", "slack", "Slack", "work-northwind", 1, "read-only"),
  source("jira", "jira", "Jira", "work-northwind", 6, "read-write"),
  source("confluence", "confluence", "Confluence", "work-northwind", 25, "read-write"),
  {
    ...source("sentry", "sentry", "Sentry", "work-northwind", 3 * DAY, "read-only", "error"),
    problem: "The access token expired. Items below are from the last good sync.",
  },
];

export const SPACES_ITEMS: readonly SpacesItemFixture[] = [
  {
    id: "notion-q4-roadmap",
    name: "Q4 personal roadmap",
    type: "page",
    source: "notion",
    space: "personal",
    location: "Planning",
    owner: "You",
    updatedAt: ago(55),
    usedInChats: 3,
    pinned: true,
    excerpt:
      "Three bets for the quarter: ship the Spaces prototype, finish the Effect v4 migration in the fork, and write up the dithered design system so it stops living in my head.",
  },
  {
    id: "notion-thinking-in-systems",
    name: "Reading notes: Thinking in Systems",
    type: "page",
    source: "notion",
    space: "personal",
    location: "Reading / 2026",
    owner: "You",
    updatedAt: ago(4 * DAY),
    usedInChats: 1,
    pinned: false,
    excerpt:
      "Leverage points, ranked from weakest to strongest. Parameters are at the bottom; the goals of the system and the paradigm it rests on are at the top.",
  },
  {
    id: "drive-release-checklist",
    name: "T3 Code fork: release checklist",
    type: "doc",
    source: "drive",
    space: "personal",
    location: "My Drive / T3 Code",
    owner: "You",
    updatedAt: ago(3 * HOUR),
    usedInChats: 4,
    pinned: true,
    excerpt:
      "Before tagging: set T3CODE_DESKTOP_UPDATE_REPOSITORY, confirm the channel manifest, sign the macOS build, and smoke-test the updater against the previous release.",
  },
  {
    id: "drive-finances",
    name: "Household budget 2026",
    type: "sheet",
    source: "drive",
    space: "personal",
    location: "My Drive / Admin",
    owner: "You",
    updatedAt: ago(2 * DAY),
    usedInChats: 0,
    pinned: false,
    excerpt:
      "Monthly totals by category with a running delta against plan. September closed 8% under budget, mostly from skipped travel.",
    preview: {
      kind: "sheet",
      columns: ["Category", "Plan", "Actual", "Delta"],
      rows: [
        ["Housing", "1,900", "1,900", "0"],
        ["Groceries", "600", "571", "-29"],
        ["Transport", "250", "232", "-18"],
        ["Travel", "300", "90", "-210"],
        ["Total", "3,050", "2,793", "-257"],
      ],
    },
  },
  {
    id: "drive-lease",
    name: "Lease agreement.pdf",
    type: "pdf",
    source: "drive",
    space: "personal",
    location: "My Drive / Admin / Housing",
    owner: "You",
    updatedAt: ago(41 * DAY),
    usedInChats: 0,
    pinned: false,
    excerpt:
      "Notice period of three months, to the end of any month except December. Deposit held in a blocked account at the tenant's bank.",
    preview: { kind: "pdf", pages: 7 },
  },
  {
    id: "drive-whiteboard",
    name: "whiteboard-orchestration.png",
    type: "image",
    source: "drive",
    space: "personal",
    location: "My Drive / T3 Code / Sketches",
    owner: "You",
    updatedAt: ago(9 * DAY),
    usedInChats: 2,
    pinned: false,
    excerpt:
      "Photo of the whiteboard: commands into the decider, events into the projector, reactors hanging off the event stream with receipts going back to the client.",
  },
  {
    id: "github-diff-names",
    name: "Diff file names are clipped at the bottom",
    type: "issue",
    source: "github",
    space: "personal",
    location: "pingdotgg/t3code #14375",
    owner: "theo",
    updatedAt: ago(20 * HOUR),
    usedInChats: 1,
    pinned: false,
    excerpt:
      "Descenders on file names in the diff panel header get cut off at some zoom levels. Looks like the line box is trimmed but the padding never came back.",
    file: "pingdotgg/t3code/issues/14375.md",
    pullRequest: { repository: "pingdotgg/t3code", number: 14375 },
  },
  {
    id: "github-spaces-proto",
    name: "Spaces tab: UI prototype",
    type: "issue",
    source: "github",
    space: "personal",
    location: "JustYannicc/t3code #12",
    owner: "You",
    updatedAt: ago(35),
    usedInChats: 2,
    pinned: true,
    excerpt:
      "Mock the Spaces panel and page with fixture data so we can judge the layout before wiring Executor sources. No backend work in this issue.",
    file: "JustYannicc/t3code/issues/12.md",
    pullRequest: { repository: "JustYannicc/t3code", number: 15 },
  },
  {
    id: "gmail-transit-renewal",
    name: "Your annual transit pass renews next month",
    type: "email",
    source: "gmail",
    space: "personal",
    location: "Inbox",
    owner: "City Transit",
    updatedAt: ago(6 * HOUR),
    usedInChats: 0,
    pinned: false,
    excerpt:
      "Your annual pass will renew automatically. To change your plan or pause it, do so at least a week before the renewal date.",
    file: "Inbox/2026-09-30 Transit pass renewal.eml.md",
  },
  {
    id: "gmail-design-partner",
    name: "Re: Design partner intro",
    type: "email",
    source: "gmail",
    space: "personal",
    location: "Inbox / Follow up",
    owner: "Leona Voss",
    updatedAt: ago(26 * HOUR),
    usedInChats: 1,
    pinned: false,
    excerpt:
      "Thanks for the demo. Could you send over the latency numbers you mentioned and a rough idea of what a pilot would look like on our side?",
    file: "Inbox/Follow up/2026-09-29 Re Design partner intro.eml.md",
  },
  {
    id: "raindrop-effect-v4",
    name: "Effect v4 migration guide",
    type: "link",
    source: "raindrop",
    space: "personal",
    location: "Engineering",
    owner: "effect.website",
    updatedAt: ago(3 * DAY),
    usedInChats: 5,
    pinned: false,
    excerpt:
      "What changed between v3 and v4: renamed services and layers, the new Schema codecs, and the behaviour differences worth checking in tests.",
  },
  {
    id: "raindrop-dithering",
    name: "Ordered dithering, explained",
    type: "link",
    source: "raindrop",
    space: "personal",
    location: "Design",
    owner: "surma.dev",
    updatedAt: ago(18 * DAY),
    usedInChats: 0,
    pinned: false,
    excerpt:
      "Bayer matrices, threshold maps and why ordered dithering stays stable under animation where error diffusion shimmers.",
  },
  {
    id: "todoist-passport",
    name: "Renew passport",
    type: "task",
    source: "todoist",
    space: "personal",
    location: "Personal · due Fri",
    owner: "You",
    updatedAt: ago(5 * HOUR),
    usedInChats: 0,
    pinned: false,
    excerpt: "Book an appointment at the passport office. Bring the old passport and one photo.",
    file: "Personal/Renew passport.task.json",
  },
  {
    id: "confluence-onboarding",
    name: "Terminal onboarding runbook",
    type: "page",
    source: "confluence",
    space: "work-northwind",
    location: "TERM / Runbooks",
    owner: "Marco Keller",
    updatedAt: ago(2 * DAY),
    usedInChats: 3,
    pinned: true,
    excerpt:
      "Provision the terminal in the portal, pair it to the merchant space, then push the firmware profile. Never sideload builds onto customer devices.",
  },
  {
    id: "confluence-firmware",
    name: "A920 firmware matrix",
    type: "page",
    source: "confluence",
    space: "work-northwind",
    location: "TERM / Hardware",
    owner: "Sara Meier",
    updatedAt: ago(8 * DAY),
    usedInChats: 2,
    pinned: false,
    excerpt:
      "Which Neptune API features are verified on which firmware. Anything not listed here is unknown, not unsupported.",
  },
  {
    id: "jira-card-timeout",
    name: "Card reader times out after resume",
    type: "issue",
    source: "jira",
    space: "work-northwind",
    location: "TERM-482",
    owner: "You",
    updatedAt: ago(90),
    usedInChats: 4,
    pinned: true,
    excerpt:
      "After the terminal wakes from sleep the first contactless read times out. Second attempt succeeds. Only seen on firmware 3.2.",
    file: "TERM/TERM-482.md",
  },
  {
    id: "jira-receipt-spacing",
    name: "Receipt footer spacing is off on the printer",
    type: "issue",
    source: "jira",
    space: "work-northwind",
    location: "TERM-501",
    owner: "Sara Meier",
    updatedAt: ago(5 * DAY),
    usedInChats: 0,
    pinned: false,
    excerpt:
      "The merchant footer prints with an extra blank line before the VAT block. Reproducible on every A920 in the lab.",
    file: "TERM/TERM-501.md",
  },
  {
    id: "slack-rollout",
    name: "Firmware 3.3 rollout thread",
    type: "message",
    source: "slack",
    space: "work-northwind",
    location: "#terminal-team",
    owner: "Marco Keller",
    updatedAt: ago(14),
    usedInChats: 1,
    pinned: false,
    excerpt:
      "Rolling 3.3 to the pilot merchants tomorrow at 7. If anything looks off on the dashboards, pull the profile back before 9 and ping me.",
    file: "terminal-team/2026-09-30 Firmware 3.3 rollout.md",
  },
  {
    id: "slack-invoice-export",
    name: "Invoice export for September",
    type: "message",
    source: "slack",
    space: "work-northwind",
    location: "DM with Nina Graf",
    owner: "Nina Graf",
    updatedAt: ago(7 * HOUR),
    usedInChats: 0,
    pinned: false,
    excerpt:
      "Can you drop the card receipts for September into the finance folder by Thursday? Two are still missing from the export.",
    file: "dm/nina-graf/2026-09-30.md",
  },
  {
    id: "sentry-payment-sheet",
    name: "IllegalStateException in PaymentSheet.onResume",
    type: "issue",
    source: "sentry",
    space: "work-northwind",
    location: "terminal-app · production",
    owner: "Unassigned",
    updatedAt: ago(3 * DAY + 2 * HOUR),
    usedInChats: 1,
    pinned: false,
    excerpt:
      "1.2k events from 84 devices. Starts right after the resume path added in 4.18; stack points at the card reader listener being registered twice.",
    file: "terminal-app/production/PaymentSheet.onResume.json",
  },
  {
    id: "notion-vision",
    name: "Vision",
    type: "page",
    source: "notion",
    space: "personal",
    location: "HQ",
    owner: "You",
    updatedAt: ago(2 * HOUR),
    usedInChats: 6,
    pinned: true,
    excerpt:
      "Every tool I use should be readable by my agents as plain files. One knowledge base, many sources, and a hard wall between work and personal.",
  },
  {
    id: "drive-dither-talk",
    name: "Dithered design system talk",
    type: "slides",
    source: "drive",
    space: "personal",
    location: "My Drive / Talks",
    owner: "You",
    updatedAt: ago(6 * DAY),
    usedInChats: 1,
    pinned: false,
    excerpt:
      "Twelve slides on why ordered dithering beats gradients for small UI surfaces, with before and after shots from three projects.",
    preview: {
      kind: "slides",
      slides: [
        "Dither, don't blend",
        "Bayer matrices in one slide",
        "Where gradients band",
        "Tokens, not pixels",
        "Three projects, before and after",
        "What to steal",
      ],
    },
  },
  {
    id: "photos-2026-09",
    name: "September 2026",
    type: "album",
    source: "photos",
    space: "personal",
    location: "Library / 2026",
    owner: "You",
    updatedAt: ago(8 * HOUR),
    usedInChats: 1,
    pinned: false,
    excerpt:
      "142 photos: a weekend in the mountains, the whiteboard session at the office, and receipts snapped for the card bill.",
    file: "2026-09",
    preview: {
      kind: "album",
      total: 142,
      photos: [
        { name: "IMG_4102.jpg", takenAt: ago(8 * HOUR), place: "Home", tone: "info" },
        { name: "IMG_4098.jpg", takenAt: ago(DAY), place: "Home", tone: "muted" },
        { name: "IMG_4071.jpg", takenAt: ago(3 * DAY), place: "Valley trail", tone: "primary" },
        { name: "IMG_4070.jpg", takenAt: ago(3 * DAY), place: "Mountain hut", tone: "success" },
        { name: "IMG_4066.jpg", takenAt: ago(3 * DAY), place: "Summit", tone: "info" },
        { name: "IMG_4051.jpg", takenAt: ago(4 * DAY), place: "Mountain hut", tone: "warning" },
        { name: "IMG_4032.jpg", takenAt: ago(9 * DAY), place: "Office", tone: "muted" },
        { name: "IMG_4019.jpg", takenAt: ago(12 * DAY), place: "Old town", tone: "error" },
      ],
    },
  },
  {
    id: "northwind-drive-q3-plan",
    name: "Q3 plan",
    type: "doc",
    source: "northwind-drive",
    space: "work-northwind",
    location: "Shared drives / Terminal",
    owner: "Marco Keller",
    updatedAt: ago(4 * HOUR),
    usedInChats: 5,
    pinned: true,
    excerpt:
      "Ship firmware 3.3 to every pilot merchant, cut contactless timeouts in half, and move receipt printing onto the shared template service.",
    file: "Q3 plan.gdoc.md",
  },
  {
    id: "northwind-drive-fleet-review",
    name: "Terminal fleet review",
    type: "slides",
    source: "northwind-drive",
    space: "work-northwind",
    location: "Shared drives / Terminal / Reviews",
    owner: "Sara Meier",
    updatedAt: ago(DAY + 3 * HOUR),
    usedInChats: 2,
    pinned: false,
    excerpt:
      "Quarterly look at the A920 fleet: firmware spread, failure rates by merchant segment, and what the 3.3 rollout should fix first.",
    preview: {
      kind: "slides",
      slides: [
        "Fleet at a glance",
        "Firmware spread",
        "Timeouts by segment",
        "Printer faults",
        "3.3 rollout plan",
        "Asks",
      ],
    },
  },
  {
    id: "northwind-drive-pilot-merchants",
    name: "Pilot merchants",
    type: "sheet",
    source: "northwind-drive",
    space: "work-northwind",
    location: "Shared drives / Terminal",
    owner: "Nina Graf",
    updatedAt: ago(10 * HOUR),
    usedInChats: 3,
    pinned: false,
    excerpt:
      "Twelve pilot merchants with terminal counts, current firmware and the contact who signs off on each rollout window.",
    preview: {
      kind: "sheet",
      columns: ["Merchant", "Terminals", "Firmware", "Window"],
      rows: [
        ["Café Mira", "4", "3.2", "Tue 07:00"],
        ["Northside Bikes", "2", "3.2", "Tue 07:00"],
        ["Corner Books", "6", "3.1", "Wed 06:30"],
        ["Station Kiosk", "1", "3.2", "Wed 06:30"],
      ],
    },
  },
  {
    id: "northwind-drive-a920-spec",
    name: "PAX A920 Pro spec sheet.pdf",
    type: "pdf",
    source: "northwind-drive",
    space: "work-northwind",
    location: "Shared drives / Terminal / Hardware",
    owner: "PAX Technology",
    updatedAt: ago(33 * DAY),
    usedInChats: 2,
    pinned: false,
    excerpt:
      "Android 10 on a 5.5 inch display, NFC and EMV contact, 58 mm thermal printer, 5250 mAh battery. Firmware features vary; check the matrix.",
    preview: { kind: "pdf", pages: 4 },
  },
];
