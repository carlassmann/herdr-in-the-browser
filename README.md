# Herdr Terminal

Herdr. In your browser.

![Herdr running in a mobile browser](./docs/herdr-terminal-demo.gif)

Open the [Herdr](https://herdr.dev) sessions on your machine from a browser.
Start one, pick one up, or leave it running and return later. That's it.

## Run

Requires [Bun](https://bun.sh) and Herdr on `PATH`.

```sh
bun install
bun start
```

Open http://localhost:8787. If Ghostty is installed, the terminal uses your
Ghostty colors and fonts. On a phone, **Keys** adds Ctrl, Alt, Esc, Tab, and
arrows.

## Remote access

The server listens only on `127.0.0.1`. To reach it remotely, use a named
Cloudflare Tunnel protected by Cloudflare Access. The app has no login of its
own; anyone who reaches it controls a terminal on your machine.

[Set up remote access](./docs/remote-access.md).

[Implementation notes](./docs/implementation.md) cover the details. MIT
licensed; see [LICENSE](./LICENSE).
