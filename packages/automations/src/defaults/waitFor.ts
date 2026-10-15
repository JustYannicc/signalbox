/**
 * "Wait for": an agent's `wait_for`, as an automation people can read and
 * change. Run attached to the agent's thread, it waits for one thing (an
 * event, a callback, a time, or a change in something it reads), then sends
 * the thread one message saying what happened. Waiting on a pull request,
 * another thread or an invoice is the same automation with different input.
 */
export const WAIT_FOR = `export const meta = {
  name: "Wait for",
  description: "Waits for one thing on behalf of a thread's agent (an event, a call to a callback link, or a time), then tells the agent once what happened.",
  intent: "wait for this and wake me when it happens",
} as const;

type Duration = { seconds?: number; minutes?: number; hours?: number; days?: number };
type Input = {
  threadId?: string;
  /** What's being waited on, in words, read after "Waiting for": the thread shows it. */
  until: string;
  /** What the agent asked to be told when it wakes. */
  message?: string;
  on?: string | string[];
  where?: Record<string, unknown>;
  /** A callback link's id; its URL went back to the agent. */
  callback?: string;
  at?: string;
  timeout?: Duration;
};

const SHOWN = 2000;

/** "5 minutes", "2 hours", for the message that says nothing happened. */
function describe(duration: Duration) {
  const seconds = (duration.seconds ?? 0) + (duration.minutes ?? 0) * 60 + (duration.hours ?? 0) * 3600 + (duration.days ?? 0) * 86400;
  const [amount, unit] = seconds >= 172800 ? [seconds / 86400, "days"] : seconds >= 7200 ? [seconds / 3600, "hours"] : seconds >= 120 ? [seconds / 60, "minutes"] : [seconds, "seconds"];
  return \`\${Math.round(amount * 10) / 10} \${unit}\`;
}

const shown = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > SHOWN ? \`\${text.slice(0, SHOWN)}…\` : text;
};

/** An event as the agent reads it: its name, then its own fields. */
function describeEvent(event: Record<string, unknown>) {
  const { event: name, id, at, projectId, ...fields } = event;
  return \`\${String(name)} happened at \${String(at)}: \${shown(fields)}\`;
}

/** What the agent reads when the wait ends; it doesn't see the automation. */
function wakeMessage(input: Input, news: string) {
  return [\`You were waiting for \${input.until}.\`, news, ...(input.message ? ["", input.message] : [])].join("\\n");
}

export default workflow(async (w, input: Input, trigger: { attach?: { threadId: string } }) => {
  const threadId = input.threadId ?? trigger.attach?.threadId;
  if (!threadId) throw new Error("Pass threadId, or start the run attached to the thread to wake.");
  const waited = input.timeout ? \`within \${describe(input.timeout)}\` : "";
  let news = "";

  if (input.at) {
    await w.sleep(\`Waiting for \${input.until}\`, { until: input.at });
    news = \`It's \${input.at}.\`;
  } else if (input.callback) {
    // A literal "on" keeps the call from the run's start, so one racing this step isn't lost.
    const call = await w.waitFor(\`Waiting for \${input.until}\`, {
      on: "hook.called",
      where: { hookId: input.callback },
      timeout: input.timeout,
    });
    news = call === null
      ? \`Nobody called the callback link \${waited}, so I stopped waiting.\`
      : \`The callback link was called (\${call.method}) with: \${shown(call.body)}\`;
  } else if (input.on) {
    const event = await w.waitFor(\`Waiting for \${input.until}\`, {
      on: input.on,
      where: input.where,
      timeout: input.timeout,
    });
    news = event === null ? \`It didn't happen \${waited}, so I stopped waiting.\` : describeEvent(event);
  } else {
    throw new Error("Say what to wait for: on, callback or at.");
  }

  await w.call("Wake the agent", "signalbox.t3_thread_send", {
    threadId,
    mode: "queue",
    message: wakeMessage(input, news),
  });
  return news;
});
`;
