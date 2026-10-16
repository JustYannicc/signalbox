import { exempt, read, type Reach, write, type WsRpcMethod } from "./reach.ts";

/** Signalbox's own RPC groups (`SIGNALBOX_WS_RPCS` in contracts' rpc.ts). */
export const SIGNALBOX_RPC_REACH = {
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
  "automations.runNow": write({ name: "automations.run", summary: "Run an automation now." }),
  "automations.customize": write(),
  "automations.stopAttached": write(),
  "automations.cancelRun": write({ name: "automations.runs.cancel" }),
  "automations.retryRun": write({ name: "automations.runs.retry" }),
  "automations.publish": write(),
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
  "signalbox.folders.setSecrets": write(),
  "signalbox.folders.setOnePassword": write(),

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

  "signalbox.previews.subscribe": read({ name: "previews.list" }),
  "signalbox.previews.open": write(),

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
} as const satisfies Partial<Record<WsRpcMethod, Reach>>;
