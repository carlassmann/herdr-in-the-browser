const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export interface RequestOriginHeaders {
  host: string | null;
  origin: string | null;
}

export function parsePublicHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

// Comparing Origin to Host alone would accept a DNS-rebinding page, which
// controls both headers. The Host itself must name this server.
export function isTrustedRequest(
  headers: RequestOriginHeaders,
  publicHosts: readonly string[] = [],
): boolean {
  const host = headers.host?.toLowerCase();
  if (!host || !isAllowedHost(host, publicHosts)) return false;
  if (!headers.origin) return true;
  try {
    return new URL(headers.origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function isAllowedHost(host: string, publicHosts: readonly string[]): boolean {
  const hostname = withoutPort(host);
  return [...LOOPBACK_HOSTS, ...publicHosts].some(
    (allowed) => allowed === host || allowed === hostname,
  );
}

function withoutPort(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}
