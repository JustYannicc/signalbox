# Codex

Signalbox runs Codex on the accounts in a pool: ChatGPT accounts and OpenAI API keys.

## Accounts

On **Usage → Limits**, choose **Add account → ChatGPT** to sign in, or **Add account → API key** for
an OpenAI or OpenRouter key. With several accounts in a pool, each conversation stays on one account,
and work moves to another when one runs out. See
[Use several subscription accounts](./usage.md#use-several-subscription-accounts).

If Codex is already signed in on the server, with `codex login` or with Signalbox's own ChatGPT
sign-in, choose **Move into** a pool in **Settings → Providers**. Signalbox then stops using that
login directly.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
