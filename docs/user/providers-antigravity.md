# Antigravity

Signalbox runs Google's official Antigravity ACP agent on your selected environment.
Its accounts live in a pool, separate from the Antigravity IDE or CLI. Google controls
which models and account access are available through this agent.

## Set up Antigravity

Antigravity accounts and Gemini API keys live in a pool. On **Usage → Limits**, choose **Add account →
Antigravity** to sign in with Google, or **Add account → API key** for a Gemini key. The pool's
**Antigravity** provider then appears in the model picker. See
[Use several subscription accounts](./usage.md#use-several-subscription-accounts).

## Runtime installation

Managed installation supports Apple Silicon macOS, Linux x64 or ARM64, and Windows
x64 or ARM64. Intel Macs can connect to a supported remote environment. Allow
several GB of free disk space, especially on Linux.

### Use a manual installation

Download the archive for your environment from the [official ACP Registry][registry].
Extract the ACP executable and its `localharness_external` helper into the same
directory, at the same version. Make both executable on macOS or Linux; Windows
uses `.exe` files.

Set **Binary path** to the ACP executable on the environment and update it yourself.
Leave the field blank to use the managed runtime, or a compatible executable on
`PATH` if no managed runtime is installed.

## Models and threads

The model list comes from your Antigravity account and can differ from other
Antigravity apps. A resumed thread keeps its selected model. If access to that
model ends, select another available model before continuing.

Use Antigravity's native `/plan` command for planning. Signalbox's separate Plan mode
is unavailable. Tool approvals follow [Permission modes](./permission-modes.md).
Questions with fixed choices still need one of the offered answers, even in
**Full access**.

Signalbox keeps conversation history and file diffs, but Antigravity cannot rewind
its conversation. Reverting a thread or editing and resubmitting an earlier turn
is unavailable. Continue with a follow-up message or start a new thread.

### Skills and attachments

Put project skills in `.agents/skills`. Signalbox also reads `.gemini/skills` and the
legacy `.agent/skills` directory. Among these project locations, the first copy
wins in this order: `.gemini/skills`, `.agents/skills`, `.agent/skills`. See
[commands and skills](./composer.md#commands-and-skills) for invoking them.

Skills for every project go in `~/.gemini/config/skills` or
`~/.gemini/antigravity-cli/skills`. Antigravity does not read `~/.agents/skills`,
so a skill there only appears when the project itself is your home directory.

Antigravity receives images directly. Every other attachment, including PDFs,
text, audio, archives, and videos, is passed as a saved file path for the agent
to inspect with its tools. A video path does not enable native video input.

### Subagents

Antigravity groups subagent activity into batches. You cannot open or control
individual subagents, and an idle batch does not confirm that every child
succeeded. See [agent work](./thread-sidebar.md#inspect-agent-work) for where to
inspect activity.

## Accounts and removal

Each Google account is an account in a pool; add, pause, or remove it on **Usage → Limits**.
Disabling the provider stops its sessions and keeps the accounts. Removing the downloaded runtime
keeps the accounts and thread history.

Before removing a managed runtime, disable its instances and cancel any active
installation. Clear any explicit binary path pointing into that runtime. Removal
is refused while the runtime is in use.

## Check access and troubleshoot

A server restart keeps your Google sign-in. The provider shows the saved account
until a session, a refresh, or a sign-out reports something new.

To check access and reload models, use **Refresh provider status** in web or desktop
provider settings, or **Refresh models** in mobile thread settings. If an account
is signed out, choose **Sign in again** on it in **Usage → Limits**.

If Google reports `SUBSCRIPTION_REQUIRED`, an account restriction, or a usage limit,
follow the provider's message and any retry time. See [Google's account plans][plans]
for eligibility.

[registry]: https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
[plans]: https://antigravity.google/docs/plans
