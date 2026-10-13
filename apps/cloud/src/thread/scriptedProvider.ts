import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * The scripted provider: a stand-in harness that runs inside the thread's own
 * object, for clouds without machines and for testing. Its reply is a pure
 * function of the user's message, so a turn can stop anywhere (an evicted
 * object, a redeploy) and continue from whatever its events already recorded.
 */

export const SCRIPTED_INSTANCE_ID = ProviderInstanceId.make("scripted");
export const SCRIPTED_DRIVER = ProviderDriverKind.make("scripted");
const SCRIPTED_MODEL = "scripted-echo";

export const scriptedModelSelection: ModelSelection = {
  instanceId: SCRIPTED_INSTANCE_ID,
  model: SCRIPTED_MODEL,
};

/** How the cloud advertises the provider, so clients can pick it and send. */
export const scriptedServerProvider = (checkedAt: string): ServerProvider => ({
  instanceId: SCRIPTED_INSTANCE_ID,
  driver: SCRIPTED_DRIVER,
  displayName: "Scripted",
  badgeLabel: "Preview",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
  supportsTextGeneration: false,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  availability: "available",
  models: [
    {
      slug: SCRIPTED_MODEL,
      name: "Scripted echo",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
});

const ECHO_LIMIT = 200;
const WORDS_PER_CHUNK = 3;

/** The full reply to `userText`. Deterministic: the same message always gets the same reply. */
export function scriptedReply(userText: string): string {
  const trimmed = userText.trim().replace(/\s+/g, " ");
  const echo = trimmed.length > ECHO_LIMIT ? `${trimmed.slice(0, ECHO_LIMIT)}…` : trimmed;
  return [
    echo.length > 0 ? `You said: “${echo}”.` : "You sent an empty message.",
    "This is a scripted reply from Signalbox Cloud. No model ran: a scripted provider stands in",
    "for a real harness, and the reply streams from this thread's own Durable Object.",
  ].join(" ");
}

/**
 * The prefix of `reply` to show after `shown` characters, one chunk further.
 * Chunks end on word boundaries, so a resumed turn lands on the same ones.
 */
export function nextScriptedPrefix(reply: string, shown: number): string {
  const words = reply.match(/\S+\s*/g) ?? [];
  let length = 0;
  for (let index = 0; index < words.length; index += WORDS_PER_CHUNK) {
    length += words
      .slice(index, index + WORDS_PER_CHUNK)
      .reduce((sum, word) => sum + word.length, 0);
    const prefix = reply.slice(0, length).trimEnd();
    if (prefix.length > shown) return prefix;
  }
  return reply;
}
