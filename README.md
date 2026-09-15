# Herdr Terminal

![Herdr Terminal running in a mobile browser](./docs/herdr-terminal-usage.gif)

A self-hosted web terminal for [Herdr](https://herdr.dev). It gives you a
browser tab onto a machine running Herdr, for when SSH into that machine is not
feasible: a network that only lets HTTPS out, a borrowed computer with no keys
on it, a phone. The terminal is `ghostty-web` (libghostty compiled to WASM)
configured from your own `ghostty` config, so the fonts, colors, padding, and
key handling match the Ghostty window on the host.

A Bun server binds to `127.0.0.1`, owns the PTYs, and serves a PWA. It
talks to the browser over a WebSocket, and falls back to SSE and then long
polling where those are blocked or stalled. Nothing listens on a public
interface; `cloudflared` makes the outbound connection and Cloudflare Access
does the authentication.

## Run

Requires [Bun](https://bun.sh) and `herdr` on `PATH`. Developed on macOS;
nothing in the server is macOS-specific except where noted below.

```sh
bun install
bun dev      # http://localhost:8787, hot reload
bun start    # production mode
bun run check
```

One Bun process bundles the frontend and serves the API. There is no separate
dev server, proxy, or routing framework. The frontend has no UI framework
either: the screens are a session picker, a header, and a canvas the terminal
owns, so they are plain TypeScript building DOM nodes. Dropping React,
`@base-ui`, and the icon package cut the client bundle from 293 KB to 194 KB
gzipped, which is the load that has to cross the tunnel first.

## Cloudflare Tunnel

The app has no Cloudflare-specific code. Keep it on loopback and point a tunnel
at it.

```sh
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create herdr-terminal
cloudflared tunnel route dns herdr-terminal herdr.example.com
```

`~/.cloudflared/herdr-terminal.yml`:

```yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: /Users/YOU/.cloudflared/YOUR-TUNNEL-UUID.json

ingress:
  - hostname: herdr.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

The server rejects requests whose `Host` it does not recognize, so list the
public hostname:

```sh
PUBLIC_HOSTS=herdr.example.com bun start
cloudflared tunnel --config ~/.cloudflared/herdr-terminal.yml run herdr-terminal
```

Setting `PUBLIC_HOSTS` turns off browser HMR in `bun dev`, because Bun's HMR
server rejects proxied hostnames. Server hot reload still works.

Use a named tunnel. Quick Tunnels do not support SSE and cannot sit behind
Access.

### Cloudflare Access

**Required.** The app has no accounts: anyone who reaches it controls a
terminal on the host. Before exposing the hostname, create a self-hosted Access
application for it under Zero Trust → Access → Applications, with an Allow
policy limited to your identity. Do not add a bypass policy.

The `Host`/`Origin` check blocks DNS rebinding. It is not authentication.

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
[patch](./patches/ghostty-web@0.4.0.patch) applies Ghostty's pixel and
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
with a short synthesized ping. Your desktop Herdr config is untouched.

Sessions run with `TERM_PROGRAM=ghostty` because Herdr only sends notifications
to terminals it knows can show them. Browsers need a user gesture before they
play audio, so the first tap or key press in a session enables the sound.

## Transports

WebSocket first. After two failed connections the client falls back to SSE for
output with `POST` for input, and from there to long polling if SSE stalls.
`?transport=sse` or `?transport=poll` skips ahead. Network and visibility
changes trigger reconnection.

Fallback input is batched, numbered, and applied in order; a gap fails the
stream and reconnects rather than replaying uncertain input. Once the client has
fallen back it stays there until the page reloads.

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
`status`, `sync`, and `notify`. See `src/shared/protocol.ts`.

## Limits

- One trusted operator. No in-app authentication.
- Sessions and replay buffers live in server memory.
- Two browsers on one session both send input, and the last resize wins.
- iOS suspends background network activity; output resumes on reconnect.
- The notification sound is a synthesized ping, not Herdr's own sound files,
  and iOS mutes it while the tab is backgrounded.

## License

MIT
