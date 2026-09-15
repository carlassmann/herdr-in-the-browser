import { join } from "node:path";
import homepage from "../client/index.html";
import { parsePublicHosts } from "./request-origin";
import { serverRoutes } from "./routes";
import { SessionManager } from "./session-manager";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const development = process.env.NODE_ENV !== "production";
const publicHosts = parsePublicHosts(process.env.PUBLIC_HOSTS);

const server = Bun.serve({
  hostname: host,
  port,
  idleTimeout: 0,
  // Bun's HMR server rejects proxied hostnames before our host allowlist runs.
  development: development
    ? { hmr: publicHosts.length === 0, console: false }
    : false,
  ...serverRoutes({
    sessions: new SessionManager(),
    publicHosts,
    publicDirectory: join(process.cwd(), "public"),
    homepage,
  }),
});

console.log(`Herdr Terminal listening on http://${host}:${server.port}`);
