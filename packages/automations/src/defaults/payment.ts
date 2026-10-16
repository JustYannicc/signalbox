/**
 * "Payment": what happens when an agent's browser reaches a payment
 * (`needs_you_payment`, or a page with card fields or a 3-D Secure check).
 * Payments are the one browser step a person finishes (#579). By default it
 * asks, as a needs-you that opens the agent's live browser beside it; the
 * person pays there and answers Done or Failed, and the agent, which waits on
 * the run, carries on with that. A folder that wants something else (a limit,
 * a second approver) customizes it like any automation.
 */
export const PAYMENT = `export const meta = {
  name: "Payment",
  description: "Hands a payment an agent's browser reached to you: you finish it in the agent's browser, answer Done or Failed, and the agent carries on.",
  intent: "let me finish the payments my agents reach",
} as const;

type Input = {
  threadId?: string;
  /** The site, as its host. */
  site: string;
  /** What's being paid for and how much, from the agent. */
  note?: string | null;
  /** The page, when the cart lives in the person's account so their own browser can finish it. */
  ownBrowserUrl?: string | null;
};

export default workflow(async (w, input: Input, trigger: { attach?: { threadId: string } }) => {
  const threadId = input.threadId ?? trigger.attach?.threadId;
  if (!threadId) throw new Error("Pass threadId, or start the run attached to the agent's thread.");
  const answer = await w.ask(\`Finish the payment on \${input.site}\`, {
    question: [
      input.note,
      "Open the agent's browser, take over and pay. The agent waits until you say how it went.",
      input.ownBrowserUrl ? \`Or finish it in your own browser: \${input.ownBrowserUrl}\` : null,
    ].filter(Boolean).join("\\n\\n"),
    options: ["done", "failed"],
    fields: { note: { type: "text", label: "Anything the agent should know?" } },
    open: { threadId, view: "browser" },
  });
  // The agent reads this from the run: it waits on it, so nothing has to wake it.
  return { outcome: answer.choice, note: answer.values.note ?? null };
});
`;
