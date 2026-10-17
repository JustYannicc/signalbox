import { exempt, read, type Reach, write, type WsRpcMethod } from "./reach.ts";
import { SIGNALBOX_PERSON_BROWSER_WS_METHODS } from "@t3tools/contracts/signalboxPersonBrowser";

/** Signalbox's own RPC groups (`SIGNALBOX_WS_RPCS` in contracts' rpc.ts). */
export const SIGNALBOX_RPC_REACH = {
  "signalbox.timezone.get": read({ name: "timezone.get" }),
  "signalbox.timezone.set": write({
    name: "timezone.set",
    summary:
      "Set your scheduling timezone; null restores device detection. Existing schedules keep their timezone.",
  }),
  "signalbox.timezone.report": exempt("client-report", "A client reports its own device timezone."),
  "signalbox.analytics.getSettings": read({ name: "analytics.get" }),
  "signalbox.analytics.setEnabled": write({ name: "analytics.setEnabled" }),
  "signalbox.analytics.recordClientEvent": exempt(
    "client-report",
    "A client's own usage events; external callers report nothing.",
  ),

  "usageLimitSource.updateAccount": write({ name: "pools.updateAccount" }),
  "accountPool.subscribe": read({
    name: "pools.list",
    summary: "Your account pools with their accounts.",
  }),
  "accountPool.subscribeViews": read({ name: "pools.views" }),
  "accountPool.subscribeAdvice": read({ name: "pools.advice" }),
  "accountPool.create": write({ name: "pools.create" }),
  "accountPool.rename": write({ name: "pools.rename" }),
  "accountPool.delete": write({ name: "pools.delete", destructive: true }),
  "accountPool.setBacking": write({ name: "pools.setBacking" }),
  "accountPool.setRouting": write({ name: "pools.setRouting" }),
  "accountPool.importAccounts": write({ name: "pools.importAccounts" }),
  // An API key is a secret the person types; agents never hold one (#335 decision 4).
  "accountPool.addApiKey": write({ name: "pools.addApiKey", humanOnly: true }),
  "accountPool.moveNativeLogins": write({ name: "pools.moveNativeLogins" }),
  "accountPool.setOpenCode": write({ name: "pools.setOpenCode" }),
  "accountPool.receive": write({ name: "pools.receive" }),
  "accountPool.moveToCloud": write({ name: "pools.moveToCloud" }),

  "automations.subscribe": read({
    name: "automations.list",
    summary: "Every automation with its last run.",
  }),
  "automations.subscribeOne": read({
    name: "automations.get",
    summary: "One automation with its source, graph and recent runs.",
  }),
  "automations.subscribeRun": read({
    name: "automations.runs.get",
    summary: "Read one run of an automation: its graph and steps.",
  }),
  "automations.setEnabled": write(),
  "automations.delete": write({ destructive: true }),
  "automations.rotateWebhook": write(),
  "automations.setWebhookSecret": write(),
  "automations.githubSubscriptions": read({
    summary: "GitHub event subscriptions and connection errors for your folders.",
  }),
  "automations.runNow": write({ name: "automations.run", summary: "Run an automation now." }),
  "automations.customize": write(),
  "automations.stopAttached": write(),
  "automations.cancelRun": write({ name: "automations.runs.cancel" }),
  "automations.retryRun": write({ name: "automations.runs.retry" }),
  // Only the app's publish vouches for the code (`apps/cloud/src/automations/automationRpc.ts`).
  "automations.publish": write({
    summary:
      "Make an automation's draft live. It doesn't vouch for the code: tools only a person-published version may use need a person to publish it in the app.",
  }),
  "automations.discardDraft": write(),
  // A run waiting on `w.ask` is a decision gate (#335 decision 4).
  "automations.answer": write({
    humanOnly: true,
    summary: "Answer a run that is waiting for you.",
  }),
  "automations.subscribeNotices": read({ name: "automations.notices" }),
  "automations.connectionStatus": read(),
  "automations.connect": write(),
  "automations.disconnect": write(),
  "automations.validate": read({
    summary: "Check an automation file without saving it: its outline, or what to fix.",
    compiles: true,
  }),
  "automations.save": write({
    summary: "Save an automation file in a folder; new, or a new version with automationId.",
    compiles: true,
  }),
  "automations.taskLifecycle": write({
    summary: "Read or change a task's completion condition and lifecycle.",
  }),

  "sections.subscribe": read({ name: "sections.list" }),
  "sections.create": write(),
  "sections.update": write(),
  "sections.move": write(),
  "sections.delete": write({ destructive: true }),
  "sections.moveProject": write(),

  "signalbox.contexts.subscribe": read({ name: "contexts.list" }),

  "signalbox.drives.subscribe": read({ name: "drives.list" }),
  "signalbox.drives.create": write(),
  "signalbox.drives.members": read(),
  "signalbox.drives.share": write(),
  "signalbox.drives.unshare": write(),
  "signalbox.drives.shareFolder": write(),
  "signalbox.drives.shortcuts": read(),
  "signalbox.drives.addShortcut": write(),
  "signalbox.drives.removeShortcut": write(),

  "signalbox.folders.subscribe": read({
    name: "folders.list",
    summary: "Your folders, nested, with their instructions and pools.",
  }),
  "signalbox.folders.create": write({ summary: "Create a folder." }),
  "signalbox.folders.update": write({ summary: "Rename a folder or change its settings." }),
  "signalbox.folders.move": write({ summary: "Move a folder under another one." }),
  "signalbox.folders.delete": write({ destructive: true }),
  "signalbox.folders.moveThread": write({
    name: "threads.move",
    summary: "File a thread in a folder.",
  }),
  "signalbox.folders.setInstructions": write(),
  "signalbox.folders.setPhase": write({
    summary:
      "Move a folder to another of its phases (for example Production), edit its phases, or clear them.",
  }),
  "signalbox.folders.setSecrets": write(),
  "signalbox.folders.setOnePassword": write(),
  "signalbox.folders.setGitHubLend": write({
    summary: "Lend your connected GitHub to a folder's CI steps, or stop lending it.",
  }),

  "signalbox.notes.subscribe": read({
    name: "notes.list",
    summary: "Your notes on every pad, with what was made of them and the tasks they became.",
  }),
  "signalbox.notes.create": write({ summary: "Jot a note on a folder's pad or the top level's." }),
  "signalbox.notes.update": write({ summary: "Change a note's words or who may read it." }),
  "signalbox.notes.delete": write({ destructive: true }),
  "signalbox.notes.readAgain": write(),
  "signalbox.notes.dismissReading": write(),
  "signalbox.notes.accept": write({
    summary: "Turn a note's offer into a task in its folder, starting with the note's words.",
  }),

  "signalbox.threadKinds.subscribe": read({
    name: "threadKinds.list",
    summary: "Which threads are chats and which are tasks, and when idle chats archive.",
  }),
  "signalbox.threadKinds.setKind": write({
    name: "threads.setKind",
    summary: "Make a thread a chat or a task.",
  }),
  "signalbox.threadKinds.setArchiveChatsAfterDays": write({
    name: "threadKinds.setArchiveChatsAfterDays",
  }),

  "signalbox.threadStatus.subscribe": read({
    name: "threadStatus.list",
    summary: "Each thread's status note: the next step, and where the work got to.",
  }),

  "signalbox.previews.subscribe": read({ name: "previews.list" }),
  "signalbox.previews.open": write(),
  // The agent's browser (#587): agents drive it through their own `preview_*` tools.
  "signalbox.previews.browserWatch": exempt(
    "client-local",
    "A live mirror of the agent's page for a client's replayer to show.",
  ),
  "signalbox.previews.browserInput": exempt(
    "client-local",
    "A person's own input to the page they watch; agents act through preview_* tools.",
  ),
  "signalbox.previews.browserTrail": read({
    name: "previews.browserSteps",
    summary: "The steps an agent took in its browser in a thread.",
  }),
  "signalbox.previews.browserStep": exempt(
    "client-local",
    "One step's page recording, for a client's replayer to show.",
  ),

  "signalbox.browsing.subscribe": read({
    name: "browsing.get",
    summary:
      "A thread's browser tabs: which one is active, where each was read to, and which are shared.",
  }),
  "signalbox.browsing.dispatch": write({
    name: "browsing.change",
    summary:
      "Open, navigate, move, switch to, close, position, share or stop sharing one of a thread's browser tabs.",
  }),

  "signalbox.push.registerDevice": exempt(
    "client-local",
    "Registers the calling app's own push token; only that app has one.",
  ),
  "signalbox.push.unregisterDevice": exempt(
    "client-local",
    "Unregisters the calling app's own push token.",
  ),

  "signalbox.repositories.list": read(),

  "signalbox.keys.list": read({ name: "keys.list", summary: "Your personal keys." }),
  // An agent never mints a credential for its person.
  "signalbox.keys.create": write({
    name: "keys.create",
    humanOnly: true,
    summary: "Make a personal key for a script or a computer's harnesses.",
  }),
  "signalbox.keys.revoke": write({ name: "keys.revoke", summary: "Revoke a personal key." }),

  "signalbox.signIn.subscribe": read({
    name: "signIn.grants",
    summary: "Where agents may sign in with your 1Password without asking.",
  }),
  // Granting is the person deciding for their agents; an agent never grants itself.
  "signalbox.signIn.grant": write({
    name: "signIn.grant",
    humanOnly: true,
    summary: "Let agents sign in to a site, or everywhere, without asking.",
  }),
  "signalbox.signIn.revoke": write({
    name: "signIn.revoke",
    summary: "Stop agents signing in to a site without asking.",
  }),
  "signalbox.signIn.check": read({
    name: "signIn.check",
    summary: "Whether agents would sign in to a site without asking.",
  }),

  [SIGNALBOX_PERSON_BROWSER_WS_METHODS.profileStatus]: read({
    name: "personBrowser.profileStatus",
    summary: "Whether your one cloud browser profile is available.",
  }),
  [SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile]: write({
    name: "personBrowser.clearProfile",
    summary: "Clear your cloud browser sessions, saved site data, and managed sign-ins.",
    destructive: true,
  }),
} as const satisfies Partial<Record<WsRpcMethod, Reach>>;
