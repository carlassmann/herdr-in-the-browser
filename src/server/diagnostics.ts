import type { RequestMeasurement } from "../shared/diagnostics";

const WINDOW_MS = 10 * 60_000;
const MAX_CLIENTS = 32;
const MAX_REQUESTS = 512;
const metrics = [
  "queueMs",
  "requestMs",
  "serverMs",
  "overheadMs",
  "batchSize",
  "inputBytes",
  "outputBytes",
  "headersMs",
  "consumeMs",
  "setupMs",
  "dnsMs",
  "connectMs",
  "firstByteMs",
  "transferMs",
  "afterResponseMs",
  "firstByteOverheadMs",
] as const;
type Metric = (typeof metrics)[number];
type StoredMeasurement = Partial<RequestMeasurement> & {
  id: string;
  at: number;
  serverObservedMs?: number;
};
interface ClientDiagnostics {
  session: string;
  clientId: string;
  lastSeen: number;
  requests: Map<string, StoredMeasurement>;
}

export class DiagnosticsStore {
  private readonly clients = new Map<string, ClientDiagnostics>();

  recordServer(
    session: string,
    clientId: string,
    id: string,
    operation: string,
    transport: string,
    status: number,
    serverMs: number,
  ): void {
    if (
      !validId(clientId) ||
      !validRequestId(id, clientId) ||
      !validOperation(operation) ||
      !validTransport(transport)
    )
      return;
    const client = this.client(session, clientId);
    const existing = client.requests.get(id);
    client.requests.set(id, {
      ...existing,
      id,
      at: Date.now(),
      operation,
      transport,
      status,
      serverObservedMs: serverMs,
    });
    this.trim(client);
  }

  recordClient(session: string, clientId: unknown, value: unknown): boolean {
    if (!validId(clientId) || !Array.isArray(value) || value.length > 64)
      return false;
    const measurements = value.map((item) => readMeasurement(item, clientId));
    if (measurements.some((item) => !item)) return false;
    const client = this.client(session, clientId);
    for (const measurement of measurements) {
      const existing = client.requests.get(measurement!.id);
      client.requests.set(measurement!.id, {
        ...existing,
        ...measurement!,
        at: existing?.at ?? Date.now(),
      });
    }
    this.trim(client);
    return true;
  }

  snapshot(session?: string) {
    const now = Date.now();
    const clients = [];
    for (const [key, client] of this.clients) {
      this.trim(client);
      if (client.lastSeen < now - WINDOW_MS) {
        this.clients.delete(key);
        continue;
      }
      if (session && session !== client.session) continue;
      const requests = [...client.requests.values()].map((request) => {
        const serverMs = request.serverObservedMs ?? request.serverMs;
        return {
          ...request,
          serverMs,
          firstByteOverheadMs:
            request.firstByteMs !== undefined && serverMs !== undefined
              ? Math.max(0, request.firstByteMs - serverMs)
              : undefined,
          overheadMs:
            request.requestMs !== undefined && serverMs !== undefined
              ? Math.max(0, request.requestMs - serverMs)
              : undefined,
        };
      });
      const groups = [
        ...new Set(requests.map((r) => `${r.transport}/${r.operation}`)),
      ].map((group) => {
        const samples = requests.filter(
          (r) => `${r.transport}/${r.operation}` === group,
        );
        const summary = Object.fromEntries(
          metrics.map((metric) => [
            metric,
            summarize(
              samples
                .map((sample) => sample[metric])
                .filter((value): value is number => value !== undefined),
            ),
          ]),
        );
        return {
          group,
          requests: samples.length,
          protocols: [
            ...new Set(
              samples.map((sample) => sample.protocol).filter(Boolean),
            ),
          ],
          completedReports: samples.filter((s) => s.requestMs !== undefined)
            .length,
          failures: samples.filter(
            (s) => s.status === 0 || (s.status ?? 0) >= 400,
          ).length,
          metrics: summary as Record<Metric, ReturnType<typeof summarize>>,
        };
      });
      clients.push({
        session: client.session,
        clientId: client.clientId,
        lastSeen: new Date(client.lastSeen).toISOString(),
        groups,
        recent: requests.slice(-20),
      });
    }
    return {
      generatedAt: new Date(now).toISOString(),
      windowSeconds: WINDOW_MS / 1000,
      maxClients: MAX_CLIENTS,
      maxRequestsPerClient: MAX_REQUESTS,
      clients,
    };
  }

  private client(session: string, clientId: string): ClientDiagnostics {
    const key = `${session}/${clientId}`;
    let client = this.clients.get(key);
    if (!client)
      client = { session, clientId, lastSeen: Date.now(), requests: new Map() };
    client.lastSeen = Date.now();
    this.clients.delete(key);
    this.clients.set(key, client);
    while (this.clients.size > MAX_CLIENTS)
      this.clients.delete(this.clients.keys().next().value!);
    return client;
  }

  private trim(client: ClientDiagnostics): void {
    for (const [id, request] of client.requests) {
      if (request.at < Date.now() - WINDOW_MS) client.requests.delete(id);
    }
    while (client.requests.size > MAX_REQUESTS)
      client.requests.delete(client.requests.keys().next().value!);
  }
}

function summarize(values: number[]) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    count: values.length,
    mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    p50: round(values[Math.ceil(values.length * 0.5) - 1]!),
    p95: round(values[Math.ceil(values.length * 0.95) - 1]!),
    max: round(values.at(-1)!),
  };
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(value);
}
function validRequestId(value: unknown, clientId: string): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(`${clientId}.`) &&
    /^\d{1,12}$/.test(value.slice(clientId.length + 1))
  );
}
function validOperation(
  value: unknown,
): value is RequestMeasurement["operation"] {
  return value === "input" || value === "resize" || value === "poll";
}
function validTransport(
  value: unknown,
): value is RequestMeasurement["transport"] {
  return value === "websocket" || value === "sse" || value === "poll";
}
function readMeasurement(
  value: unknown,
  clientId: string,
): RequestMeasurement | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (
    !validRequestId(item.id, clientId) ||
    !validOperation(item.operation) ||
    !validTransport(item.transport) ||
    typeof item.status !== "number" ||
    !Number.isInteger(item.status) ||
    item.status < 0 ||
    item.status > 599 ||
    typeof item.requestMs !== "number"
  )
    return;
  const result: RequestMeasurement = {
    id: item.id,
    operation: item.operation,
    transport: item.transport,
    status: item.status,
    requestMs: item.requestMs,
  };
  if (
    typeof item.protocol === "string" &&
    /^[a-zA-Z0-9./-]{0,32}$/.test(item.protocol)
  )
    result.protocol = item.protocol;
  for (const metric of metrics) {
    if (
      metric === "overheadMs" ||
      metric === "firstByteOverheadMs" ||
      item[metric] === undefined
    )
      continue;
    const number = item[metric];
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      number < 0 ||
      number > 1_000_000_000
    )
      return;
    result[metric] = number;
  }
  return result;
}
