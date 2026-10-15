/**
 * "Wait for": an agent's `wait_for`, as an automation people can read and
 * change. Run attached to the agent's thread, it waits for one thing (an
 * event, a callback, a time, or a change in something it reads), then sends
 * the thread one message saying what happened. Waiting on a pull request,
 * another thread or an invoice is the same automation with different input.
 */
export const WAIT_FOR = `export const meta = {
  name: "Wait for",
  description: "Waits for one thing on behalf of a thread's agent (an event, a change in something a connection reads, a call to a callback link, or a time), then tells the agent once what happened.",
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
  /** Something a connection reads, watched for changes (source.item.* events). */
  watch?: {
    operation: string;
    args?: Record<string, unknown>;
    key: string;
    items?: string;
    fields?: string[];
    every?: Duration;
    connection?: string;
  };
  /** With watch: what a change has to show, in words; each change is judged against it. */
  condition?: string;
  /** A callback link's id; its URL went back to the agent. */
  callback?: string;
  at?: string;
  timeout?: Duration;
};

const SHOWN = 2000;

const seconds = (duration: Duration) =>
  (duration.seconds ?? 0) + (duration.minutes ?? 0) * 60 + (duration.hours ?? 0) * 3600 + (duration.days ?? 0) * 86400;

/** "5 minutes", "2 hours", for the message that says nothing happened. */
function describe(duration: Duration) {
  const total = seconds(duration);
  const [amount, unit] = total >= 172800 ? [total / 86400, "days"] : total >= 7200 ? [total / 3600, "hours"] : total >= 120 ? [total / 60, "minutes"] : [total, "seconds"];
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
  } else if (input.watch) {
    // Every change counts unless a condition says what it has to show; the deadline holds across changes.
    const deadline = input.timeout ? Date.now() + seconds(input.timeout) * 1000 : null;
    try {
      for (;;) {
        const left = deadline === null ? undefined : { seconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) };
        const change = await w.waitFor(\`Waiting for \${input.until}\`, {
          on: input.on ?? "source.item.*",
          watch: input.watch,
          where: input.where,
          timeout: left,
        });
        if (change === null) {
          news = \`It didn't happen \${waited}, so I stopped waiting.\`;
          break;
        }
        if (input.condition) {
          const verdict = await w.judge("Does the change show it?", {
            input: { condition: input.condition, change: { event: change.event, item: change.item, before: change.before } },
            outcomes: ["yes", "no"],
          });
          if (verdict !== "yes") continue;
        }
        news = describeEvent(change);
        break;
      }
    } catch (error) {
      // Signalbox stopped watching it after failed reads; the agent decides what next.
      news = \`I stopped waiting: \${error instanceof Error ? error.message : String(error)}\`;
    }
  } else if (input.on) {
    const event = await w.waitFor(\`Waiting for \${input.until}\`, {
      on: input.on,
      where: input.where,
      timeout: input.timeout,
    });
    news = event === null ? \`It didn't happen \${waited}, so I stopped waiting.\` : describeEvent(event);
  } else {
    throw new Error("Say what to wait for: on, watch, callback or at.");
  }

  await w.call("Wake the agent", "signalbox.t3_thread_send", {
    threadId,
    mode: "queue",
    message: wakeMessage(input, news),
  });
  return news;
});
`;
