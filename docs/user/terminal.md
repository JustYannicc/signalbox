# Terminal

Open Terminal from a thread's side panel or the command palette. You can open
several terminals, clear their output, resize them, restart them, or close them.

Cloud terminals run in the thread's workspace and stay available when you switch
devices. They keep the latest 128 KiB of output. If their machine stops, their
output remains available; restart the terminal to start a new shell.
Cloud shells also have an input limit. If one reaches it, restart it to keep typing.

On a self-hosted environment server, each terminal keeps up to 5,000 lines and
8 MiB of scrollback. Signalbox removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when Signalbox restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.
