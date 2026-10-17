# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Home

The icon rail on the left edge of the sidebar opens **Home**, which shows your threads
where they live. Collapsing the sidebar hides Home but keeps the rail. **New**, pinned
above Home, starts a thread. The back and forward arrows beside the sidebar toggle step
through where you've been.

## Organize with folders

In Signalbox Cloud, Home is your top level: your threads and folders sit right in it, and every
work organization you belong to shows inside it as a level of its own. You don't switch accounts,
and organizations you join show up the next time you sign in. Your top level and each organization
have their own folders, nested as deep as you like. Choose **New folder** at the bottom of Home or
inside an organization, or **New folder inside** in a folder's menu; the command palette has **New
folder** too. A folder's menu also renames, moves, reorders, and deletes it. Deleting a folder moves it
to Trash with every folder and thread inside it.

### Trash

In Signalbox Cloud, threads and folders you delete go to **Settings → Trash**. **Restore** puts one
back where it was, with everything that was inside it and a folder's instructions and settings.
Everything stays restorable for 30 days. Where your server deletes for good, **Empty Trash**, or
selecting items and choosing **Delete forever**, removes them with their history and files right
away; this can't be undone. On a phone, tap an item in Trash to restore it or delete it forever.
While your server doesn't delete for good, Trash says so and nothing in it is removed.

### Where threads live

Every thread lives in one place: a folder, your top level, or the top of an organization. It lives
where you start it: use the new thread button on a folder or an organization, or **New thread** in
the **⋯** menu next to **Folders** for your top level. To move a thread, right-click it and choose
**Move to folder…**, or use **Move thread to folder…** in the command palette. A thread can move
anywhere within your own levels or within its organization, never between them.

A thread acts as the level it starts in, yours or an organization's, for good: a work thread uses that
organization's identity and connections, a personal one uses yours. Moving a thread changes what it
runs on from its next message, its folder's pool and instructions. Its files stay the ones it
started in.

### A folder's files

A folder can have its own files: a shared drive, or a folder shared from a My Drive, of the same
owner, you or the organization. Pick them under **Files** in the folder's menu, or **No files of its own**.
They show as one **Files** row inside the folder; open it to browse them. Threads started in the
folder work in those files. In a folder without files of its own, they work in the files of the
top level it sits in. Each drive you're given starts out as a folder of its own, which you can
move, rename, or hand its files to another folder.

### Phases

A folder can have a phase that says where it is in its life, shown beside its name. New folders
start with one: Proposal, Initiative, Implementation, Testing, Production in an organization, and
Idea, Doing, Done in Personal. Folders made for files you already had start without one. Choose
**Phase** in a folder's menu to move it to another phase, skipping any you like, or **Edit
phases…** to rename, add, reorder, or remove them, one per line. **Move folder to phase…** in the
command palette moves the open thread's folder. Agents and automations can move it too, for example
to Production after the first deploy.

### Instructions

Each level can have instructions for agents, its own `AGENTS.md`. Choose **Instructions…** in a
folder's menu, or in the **⋯** menu next to **Folders** for the top level. Agents follow the top level's
first, then each folder's on the way down to the thread's own folder. Leave them empty to remove
them.

### Secrets

Each level can load secrets from a 1Password Environment, so threads there get them as environment
variables for things like `vp run dev` or tests. Signalbox never shows their values.

1. In the 1Password desktop app, create an Environment under **Developer › View Environments**. You
   can import a `.env` file there. Copy its ID from **Manage environment › Copy environment ID**.
2. On 1Password.com, create a service account with read access to that Environment. 1Password shows
   its token (`ops_…`) only once.
3. Choose **Secrets…** in a folder's menu, or in the **⋯** menu next to **Folders** for the top level, and
   paste the Environment ID and the token.

You add the token once; it covers all your folders. **Disconnect** in any folder's Secrets stops
secrets loading everywhere.

- Secrets load when a thread starts. New threads get a change right away; a running thread gets it
  the next time it starts up again.
- A thread gets the secrets of every level from the top level down to its folder. When two levels
  set the same name, the nearer folder wins.
- Variables the agent needs for its own model access (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN`) and ones Signalbox sets itself, such as `HOME` or `PATH`, are skipped.
- The agent's model never sees a value. Wherever a value would show, in a transcript or in what
  the model reads, base64, URL-encoded and other common forms included, it reads
  `{{secret:NAME}}` instead. Variables set to show their value by default in 1Password, and values
  of 6 characters or fewer, aren't hidden.

### Scratch pad

Every folder has a scratch pad for thoughts that aren't ready to act on, such as "after #456 merges,
also do X". Choose **Scratch pad** in a folder's menu, or in the menu beside Personal for notes that
belong nowhere in particular. The command palette has **Scratch pad** too. Type a note and press Enter.
Half-formed is fine, and nothing asks you about it later.

Your words stay exactly as you wrote them. A moment later, whoever reads the note writes what it
thinks you meant underneath, with what it would do. Choose **OK, do it** and the note becomes a task
in that folder that starts with your words, and it leaves the scratch pad. Choose **Not this**, or just
ignore it, and it stays a plain note. **Read again** in the note's menu asks for a fresh reading.

Notes are private by default: only you and your assistant read them. In an organization's folders,
switch to **Team** to write notes the folder's agent can read too. Agents working in a folder can
look up its team notes when they need them. They never see your private notes.

### Sections on your own server

On a server you run yourself, Home organizes projects into sections instead. On web and desktop,
choose **Create section** beside **Projects**. Use a section's menu to add a subsection, rename it,
move it, change its order, or delete it. Deleting a section moves its projects and child sections to
its parent. Use a project's move menu to place it in a section or back at the root. Clients
connected to the same environment share this organization. On mobile, choose **Browse sections**
from Home to navigate the project tree.

Folders and sections organize where work lives. On mobile, **Pinned**, **Active**, **Snoozed**,
and **Settled** are thread status groups.

### Drives and sharing

Your top level and each organization have a private **My Drive**. In a work organization, choose **New
shared drive** beside its name to create a drive for the organization; it shows up as a new folder. To share a folder from My Drive, right-click it in
**Files** and choose **Share folder…**. People you share it with can see that folder and its history.
Removing someone cuts their access everywhere at once. Threads stay private, even in a shared drive;
only their file changes land in the drive.

To show another drive inside one, such as a team's shared drive or a GitHub repository you imported,
right-click a folder in **Files** and choose **Add shortcut here…**, or use the shortcut button above
the file list to add one at the top. Threads in the drive see the shortcut as a read-only folder with
that drive's own history, and follow its `AGENTS.md` as well as the drive's own. To change files
there, start a thread in that drive. Only people who can open the drive a shortcut points to see it.
Right-click a shortcut and choose **Remove shortcut** to take it away; threads stop seeing it, and
its instructions, from their next message. Agents can load up to 64 KiB of instructions: if a drive
and its shortcuts bring more, the message fails and says which files to shorten.

Agents read every drive you can, everywhere, but change only the drive their thread works in.
To reuse work, tell the agent where it happened, like "in Billing we added a dark mode toggle, do the
same here". It finds the thread and its changes and redoes them in its own drive. If it can't find
enough to go on, it says so instead of guessing.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, Signalbox stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each thread without a project works in its own folder under `~/.signalbox/scratch` (the
`scratch` folder of your Signalbox data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## Chats and tasks

In Signalbox Cloud, every thread is a chat or a task, shown by the icon at the start of its row.
A chat is for thinking out loud: questions, research, weighing options. A task is work you want
done. Signalbox picks one from your first message, and a chat that starts changing files becomes a
task on its own. Click the icon to switch; **⌘Z** undoes it. The kind changes what the agent is
told, never what it can do.

Tasks leave through **Done** when you hover their row. Chats you leave alone archive themselves
after seven idle days; hover a chat's icon to see when. Change or turn this off in **Settings →
General → Archive idle chats after**. Bring an archived chat back from **Settings → Archive**.

## See where a thread got to

In Signalbox Cloud, every thread keeps a status line: what it's doing or waiting on, the next step,
and where the work got to, written so someone who has never seen the thread can pick it up. It's at
the top of **Thread details**, and on a phone at the top of the thread's settings. The next step
also shows under the thread in its folder. The agent updates the status line every turn. If it
doesn't, Signalbox writes one from the turn. Everyone with access to the thread sees the same line.

A folder shows how many of its threads are working or waiting. Hover its name to see the idle ones
too.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo when no text field is focused; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the Signalbox server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

Agents connected through Signalbox can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

On iOS and Android, turn on **Settings → Thread behavior → Working section** to move threads that are working or
monitoring into a collapsed **Working** section below the active list. A thread returns to the top
of the active list when it finishes, fails, or needs an approval or answer. The Working section
lists the thread you last sent work to first. Pinned threads stay in the pinned section. Each
device keeps its own choice.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep threads with a PR** in **Settings → General**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled.

Change these rules in **Settings → General** on web and desktop, or **Settings → Thread behavior** on mobile.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
On web and desktop, press **Resume** in an empty composer to continue a limited
or interrupted turn manually.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Auto-resume limited
threads** in **Settings → General** on web and desktop, or **Settings → Thread
behavior** on mobile, to schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Sending a new message, archiving, or settling the
thread prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze limited threads** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents.
Stop on a thread also stops the subagents it delegated to.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

## Snooze until later

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.
