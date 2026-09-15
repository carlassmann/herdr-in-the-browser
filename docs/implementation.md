# Implementation notes

## Sessions

The start screen lists Herdr's named sessions. Entering a new name runs
`herdr --session <name>`; picking a running one runs `herdr session attach
<name>`. The back button leaves a terminal without stopping its PTY.

The server keeps each PTY alive across browser disconnects and replays the last
1 MiB of output on reconnect. It tracks DEC private modes (mouse reporting,
alternate screen, bracketed paste, cursor visibility) and the negotiated
keyboard protocol so it can restore them when a replay starts mid-stream.

Herdr owns durable state. A server restart loses the PTYs and replay buffers;
the named Herdr sessions keep running and reappear on the start screen. There is
no tmux-like persistence layer here.

Herdr refuses to run nested inside another Herdr pane, so every spawned process
has Herdr's nesting markers removed from its environment. The server works
whether it was started from a plain shell or from inside Herdr.

## Ghostty configuration

The server reads `ghostty +show-config` and reads it again once the config or a
theme file it used has been touched, so editing the config costs a browser
reload rather than a server restart. Files pulled in through `include` are
invisible to that check, since `ghostty +show-config` resolves them and reports
only the result; touching the main config picks them up.

The terminal applies the regular and bold faces, font size, cell width/height
adjustments, window padding including `window-padding-balance` and
`window-padding-color = extend`, cursor style and blink, foreground,
background, selection colors, and the first 16 palette colors. Paired
`light:…,dark:…` themes follow `window-theme`, and `system` follows the device.
The app chrome derives its colors from the same theme. If the configured font is
installed as an OTF, TTF, WOFF, or WOFF2 file in one of the macOS font
directories, the server serves it to the browser; on other hosts, or when no
file matches, the browser resolves the family name itself.

`ghostty-web` uses Ghostty's parser with a Canvas renderer, not Metal.
Rasterization, ligature shaping, custom shaders, and macOS font thickening
cannot be pixel-identical, and settings without a browser equivalent are
ignored.

`ghostty-web@0.4.0` does not expose cell-metric adjustments. A small
[patch](../patches/ghostty-web@0.4.0.patch) applies Ghostty's pixel and
percentage adjustments during font measurement and restores the default mouse
cursor when no link is hovered. Remove it once upstream exposes equivalents.

## Input

Every key press goes through Ghostty's own key encoder with the protocol the
application negotiated, so Shift+Enter, Alt combinations, and kitty keyboard
sequences arrive as they would from a native window. Option acts as Alt, like
`macos-option-as-alt`. Pastes are bracketed when the application asked for it.

When an application enables mouse reporting, clicks, taps, drags, and wheel
events are encoded as terminal cell events. Hold Shift to bypass reporting and
select text, as in Ghostty. Herdr's own copy lands in the browser clipboard:
sessions run with `SSH_TTY` set, which makes Herdr emit `OSC 52` rather than
write the host's clipboard, and the server forwards the text as a `clipboard`
message. Tools inside the session that check `SSH_TTY` will see a remote login.

On a touch device, tap the terminal to raise the keyboard. The **Keys** menu
adds `Ctrl`, `Alt`, `Esc`, `Tab`, and arrows; `Ctrl` and `Alt` latch for the
next key press. Install it to the home screen for standalone mode.

## Notifications

Herdr would play its agent sounds on the machine hosting the PTY, where nobody
is listening. The server writes a `config.web-terminal.toml` next to your Herdr
config that sets `[ui.toast] delivery = "terminal"` and disables `[ui.sound]`,
and spawns the session with it. Herdr then emits `OSC 9` instead, which the
server forwards to the browser as a `notify` message and the browser answers
with a short synthesized ping. Your desktop Herdr config is untouched. Each new
session refreshes the derived file if the source config changed.

Sessions run with `TERM_PROGRAM=ghostty` because Herdr only sends notifications
to terminals it knows can show them. Browsers need a user gesture before they
play audio, so the first tap or key press in a session enables the sound.

## Transports

WebSocket first. After two failed connections the client falls back to SSE for
output with `POST` for input, and from there to long polling if SSE stalls.
`?transport=sse` or `?transport=poll` skips ahead. Network and visibility
changes trigger reconnection.

Fallback input is batched, numbered, and applied in order. A request that fails
or is cut off by a reconnect is sent again under the same number, and the server
applies each number once, so typed input is neither lost nor doubled. When the
server has given up on a stream it answers 409 and the client starts a new one.
Once the client has fallen back it stays there until the page reloads.
Numbered retries stay on `POST` even if WebSocket recovers; direct WebSocket
input resumes only after they are acknowledged. Slow output clients are closed
after 1 MiB queues up and reconnect through the replay buffer.

## Configuration

| Variable            | Default                       | Purpose                                              |
| ------------------- | ----------------------------- | ---------------------------------------------------- |
| `PORT`              | `8787`                        | Loopback port.                                       |
| `PUBLIC_HOSTS`      | none                          | Comma-separated hostnames accepted besides loopback. |
| `GHOSTTY_BIN`       | `ghostty` on `PATH`           | Ghostty executable.                                  |
| `HERDR_BIN`         | `herdr` on `PATH`             | Herdr executable.                                    |
| `HERDR_CONFIG_PATH` | `~/.config/herdr/config.toml` | Herdr config to derive from.                         |

## API

```
GET    /api/sessions
POST   /api/sessions          { "name": "work", "mode": "create" | "attach" }
DELETE /api/session/:id
GET    /api/appearance
GET    /api/appearance/font[/bold|/italic|/bold-italic]
GET    /api/session/:id/ws
GET    /api/session/:id/events
GET    /api/session/:id/poll
POST   /api/session/:id/input
POST   /api/session/:id/resize
```

Client messages are `input` and `resize`; server messages are `output`,
`status`, `sync`, `notify`, and `clipboard`. See
[src/shared/protocol.ts](../src/shared/protocol.ts).

## Limits

- One trusted operator. No in-app authentication.
- Sessions and replay buffers live in server memory.
- Two browsers on one session both send input, and the last resize wins.
- iOS suspends background network activity; output resumes on reconnect.
- The notification sound is a synthesized ping, not Herdr's own sound files,
  and iOS mutes it while the tab is backgrounded.
