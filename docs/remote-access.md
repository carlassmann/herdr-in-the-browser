# Remote access

The server only listens on `127.0.0.1`. A Cloudflare Tunnel can reach it without
opening a public port. **Protect the hostname with Cloudflare Access before
routing DNS.** The app has no login of its own; anyone who reaches it controls
a terminal on your machine.

On macOS, install `cloudflared` and create a named tunnel:

```sh
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create herdr-terminal
```

Put this in `~/.cloudflared/herdr-terminal.yml`:

```yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: /path/to/YOUR-TUNNEL-UUID.json

ingress:
  - hostname: herdr.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

In Cloudflare Zero Trust, create a self-hosted Access application for
`herdr.example.com`. Allow only your identity. Then restart the server with its
public hostname:

```sh
PUBLIC_HOSTS=herdr.example.com bun start
```

In another shell, route DNS and run the tunnel:

```sh
cloudflared tunnel route dns herdr-terminal herdr.example.com
cloudflared tunnel --config ~/.cloudflared/herdr-terminal.yml run herdr-terminal
```

The server accepts only loopback hosts and the names in `PUBLIC_HOSTS`. It also
checks that a request's `Origin`, when present, matches its `Host`. These checks
help block DNS rebinding; Cloudflare Access provides authentication.

When `PUBLIC_HOSTS` is set, `bun dev` keeps server hot reload but turns off
browser HMR, because Bun rejects proxied hostnames for HMR.
