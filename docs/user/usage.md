# Usage and limits

Open **Usage** from the sidebar or the command palette, or press `mod+u` on web and
desktop when the terminal is not focused. Customize `usage.open` in
**Settings → Keybindings**.

## Understand your usage

**Usage** combines Codex, Claude Code, Grok Build, OpenCode, Antigravity, and Cursor history from your connected
environments. It shows token use, cache savings, model breakdowns, and estimated API-equivalent
cost, split by token type and by speed. These estimates are not your subscription bill.
**Premium** is what Fast and Ultrafast requests cost above standard rates. Cost that cannot be
split, such as a provider-reported cost for a model without public rates, shows as **Other**.
Select a model under **Breakdown** to see its trend, cache hit rate, and cost per million tokens.

Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.

OpenCode reads its SQLite database and older JSON history. Antigravity reads local conversation
databases, including T3-managed profiles. Set `OPENCODE_DATA_DIR` or `ANTIGRAVITY_DATA_DIR` on the
server to read a different data directory; comma-separated paths read multiple directories.

Cursor reads account usage from Cursor's dashboard API using the CLI login saved on the server.
This includes headless Signalbox sessions and desktop usage across machines; the same account counts
once across connected environments. Without an accessible CLI login, Signalbox shows a
notice instead of incomplete local totals. Signalbox does not estimate missing tokens from conversation text.
On macOS, choose **Enable Cursor usage** on Usage to allow Signalbox to read your existing CLI login
from Keychain. You can turn it off in **Settings → Providers → Usage providers**. macOS may ask
you to allow access on the server Mac.

Usage includes each configured account's history, including disabled accounts. Custom homes follow
the account's home setting or its `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `GROK_HOME` environment
variable. Use absolute paths or `~/` paths in the account's environment settings; relative
environment paths depend on each project's working directory and cannot be reliably discovered
by Usage. Accounts sharing a history directory count once.

When your app and server support different providers, usage totals may cover only the providers
your app understands. Update the app to include newly supported providers.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. The dropdown shows which environments are still scanning;
results appear as each one responds, and figures still updating are dimmed. Cursor shows its last
saved totals first, then updates them when Cursor's API responds.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing. When a model on **Usage** has no known price, select it under
**Breakdown** and choose **Set price** to open this table with that model added.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

To count one model as another, such as a preview model under its released name, enter the target
model ID under **Map to**. The mapped model no longer appears on **Usage**: its tokens and cost
move to the target model and use the target's price. Clear **Map to** or reset the row to show
the model on its own again.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Track subscription limits

**Usage → Limits** pools every subscription account it can see per provider, so with several Codex
or Claude accounts across your environments and hubs, the provider summary shows how much is left
in each pooled window. Each bar has one segment per account, kept in the same column across windows.
Accounts are ordered by their 5-hour reset, soonest first, or by the first available window when no
account reports a 5-hour limit. A gap means the account does not report that window. The summary
shows the soonest reset that restores quota and the total banked reset credits, with the next expiry
when one is reported. The hatched part of a segment is what that account's reset restores. Tap a
segment for the account's plan, email, environment or hub, and reset time. On web, you can hover too.

Below the summary, **Accounts** lists each subscription account once with its individual window
bars, plan, and environment or hub source. Available reset credits include **Use reset** when that
account can redeem them. On mobile, use **Details** in a row or tap a segment to open the account
screen. Claude resets are not available when the server runs on macOS, where Claude keeps its login
in the Keychain.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
Filter with the environment dropdown to see what a single machine has.

Opening Limits checks the selected connected environments automatically. Each client waits at
least five minutes between automatic checks of an environment, including after a failed check.
If a window still looks stale, refresh Limits to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

OpenCode Go reports its session, weekly, and monthly allowance when OpenCode runs locally in
the environment. Signalbox cannot report limits for external OpenCode servers because their credentials
belong to the remote server. Limits need an OpenCode Go API key. A Console sign-in alone
does not report them. Add your Go API key as `OPENCODE_API_KEY` in the OpenCode instance's
**Environment variables**, then refresh provider status. Cursor reports
its monthly allowance, including separate Auto and API usage, using the CLI login or
`CURSOR_AUTH_TOKEN`. On macOS, this includes the default Keychain login after you enable Cursor
usage. Keychain login is used for limits only with Cursor's default API endpoint. If you configure
a custom Cursor endpoint, use an explicit token or file-based CLI login for limits.

Grok reports the remaining subscription allowance and reset time for its current billing period
after signing in with `grok login`. Explicit `XAI_API_KEY` connections and custom authentication
or endpoint configurations do not report subscription limits.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Use several subscription accounts

Every account Signalbox's agents use lives in a **pool**: ChatGPT, Claude, Grok, Antigravity, and
Cursor accounts, and API keys. Everyone starts with one pool, and you can add more, for example one
for work. Open **Usage → Limits**, choose **Add account**, pick the provider, and sign in with the
account to add. With several pools, each pool has its own **Add account**. Grok shows a code to
enter on xAI's page.

To add an API key, choose **Add account → API key**, pick the provider (Anthropic, OpenAI, xAI,
Gemini, OpenRouter, Cursor, or another OpenAI-compatible API), and paste the key. A key works beside
the pool's logins of the same provider: an Anthropic key and a Claude subscription in one pool both
take Claude conversations. Keys never report usage limits, and their menu only offers **Remove**.

In Signalbox Cloud, pools take Claude and ChatGPT sign-ins for now. API keys, imported accounts,
Cursor and OpenCode come later, and Limits lists each account without its usage bars.

In the desktop app, sign-ins finish on their own. In a browser, the provider can end on a page that
cannot load; copy that page's full address and paste it into Signalbox to finish.

The first account of each provider in a pool adds that provider, such as **Claude**, to the model
picker. Pick it to use every account of that kind in the pool: each conversation stays on one
account, and work moves to another account when one runs out. Antigravity accounts offer only its
Flash models this way.

With several pools, the model picker asks for the pool first and then shows that pool's models. A
conversation stays on its pool. To start a project's new conversations on a pool, pick a model from
that pool as the project's default model in its settings. To do it for every project in a section,
choose **Pool for new threads** in the section's menu; nested sections use their parent's pool
unless they pick their own, and a project's own default model still wins. Agents can see each pool's providers and
how much of their usage is left, so they can pick a pool for the work they hand off.

Cursor accounts in a pool run the pool's **Cursor** provider. To run OpenCode on a pool, choose **Use
with OpenCode** in the pool's menu in **Settings → Pools**: OpenCode then offers every model the pool
serves and uses only the pool's accounts, never an OpenCode login on the server.

Each account appears on **Usage → Limits** under its pool. Use its menu to pause, resume, or remove
it. ChatGPT accounts added with Sign in with ChatGPT link to ChatGPT's usage page instead of showing
bars.

When an account's login expires, it shows **Signed out**, Usage gets a red dot, and Signalbox tells
you. Choose **Sign in again** on the account and sign in with the same account; it keeps its place in
the pool. Using the same account directly in Codex or Claude Code as well can sign it out of the
pool, because each sign-in replaces the other's login.

### Move sign-ins into a pool

Providers that sign in on the server itself, such as Claude Code's or Codex's own login, Signalbox's
own ChatGPT or Cursor sign-in, or an API key in a provider's environment, can move into a pool in one
click. **Settings → Providers**, **Settings → Pools**, and the welcome wizard offer **Move into** a
pool while any are left. On macOS, the server can ask once for permission to read Claude Code's
login from the keychain.

Moving turns that provider off, and the pool's provider takes over. Using the same account directly
on the server afterwards, for example running `claude` there, can sign it out of the pool.

### Manage pools

Open **Settings → Pools** to create, rename, or delete pools. Each pool keeps its logins with
Signalbox, or in a CLIProxyAPI you already run: choose **Where it keeps logins** in the pool's menu
and enter that instance's URL, management key, and one of its API keys. Signalbox then sends the
pool's work through your instance and adds new accounts to it.

To bring accounts from a CLIProxyAPI you run into a pool, choose **Import from CLIProxyAPI** in the
pool's menu. Leave **Remove them from that CLIProxyAPI** on unless you stop using that instance:
two places refreshing the same account sign each other out.

Deleting a pool removes its providers from the model picker, and threads on it stop working. The
accounts Signalbox keeps for it are removed; a pool that keeps its logins in your CLIProxyAPI leaves
them there.

## Connect a CLIProxyAPI hub

To see the accounts of a CLIProxyAPI hub you run yourself, open **Settings → Providers → Usage
providers → Add hub**. Choose the environment that will connect to the hub and enter its URL and
management key.

The accounts appear under **Usage → Limits**, where you can pause, resume, or remove them. Codex
accounts show banked reset credits; select an account and choose **Use reset** to redeem one. No
hub plugin is required.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.

## Subscription usage widget

Add **Subscription usage** from your iOS or Android widget gallery to see remaining Codex and
Claude quotas. Tap it to open **Usage → Limits**; on Android this works while Signalbox is running in
the background, otherwise open the app from the launcher. On iOS, use **Edit Widget** to choose
Session, Weekly, or both for each provider. Reopen Signalbox to refresh expired readings.

## Keyboard shortcuts

On web and desktop, open Usage from the command palette. While on Usage,
press `C`, `T`, or `L` for Cost, Tokens, or Limits while not typing in a field.
Use `Ctrl+Shift+1/2/3/4` (`Cmd+Shift+1/2/3/4` on macOS) for the past
24 hours, 7 days, 30 days, or 90 days. Period shortcuts do nothing on Limits.
Press `Escape` to return to the previous page. Customize these shortcuts in
**Settings → Keybindings**.
