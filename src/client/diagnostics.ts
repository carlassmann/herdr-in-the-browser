import type {
  DiagnosticOperation,
  DiagnosticReport,
  DiagnosticTransport,
  RequestMeasurement,
} from "../shared/diagnostics";

export class TransportDiagnostics {
  readonly clientId = crypto.randomUUID();
  private sequence = 0;
  private completed: Array<{
    value: RequestMeasurement;
    url: string;
    started: number;
    finished: number;
  }> = [];
  private observer?: PerformanceObserver;
  private resources: PerformanceResourceTiming[] = [];
  private flushTimer?: number;

  constructor(private readonly sessionUrl: string) {}

  async request(
    operation: DiagnosticOperation,
    transport: DiagnosticTransport,
    url: string,
    init: RequestInit,
    consume: (response: Response) => Promise<void>,
    input?: { queueMs: number; batchSize: number; inputBytes?: number },
  ): Promise<void> {
    this.observeResources();
    const id = `${this.clientId}.${++this.sequence}`;
    const headers = new Headers(init.headers);
    headers.set("X-Terminal-Client", this.clientId);
    headers.set("X-Terminal-Request", id);
    headers.set("X-Terminal-Transport", transport);
    if (this.completed.length) {
      headers.set("X-Terminal-Metrics", JSON.stringify(this.take(8)));
    }
    const started = performance.now();
    let headersMs: number | undefined;
    let consumeMs: number | undefined;
    let status = 0;
    let serverMs: number | undefined;
    let outputBytes: number | undefined;
    try {
      const response = await fetch(url, { ...init, headers });
      headersMs = performance.now() - started;
      status = response.status;
      const duration = response.headers.get("X-Terminal-Server-Ms");
      if (duration !== null && Number.isFinite(Number(duration)))
        serverMs = Number(duration);
      const bytes = response.headers.get("X-Terminal-Output-Bytes");
      if (bytes !== null) outputBytes = Number(bytes);
      const consumeStarted = performance.now();
      await consume(response);
      consumeMs = performance.now() - consumeStarted;
    } finally {
      const finished = performance.now();
      this.completed.push({
        url: new URL(url, `${location.protocol}//${location.host}`).href,
        started,
        finished,
        value: {
          id,
          operation,
          transport,
          status,
          requestMs: finished - started,
          headersMs,
          consumeMs,
          serverMs,
          outputBytes,
          ...input,
        },
      });
      if (this.completed.length > 64) this.completed.shift();
      this.scheduleFlush();
    }
  }

  flush(): void {
    window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.completed.length) return;
    const report: DiagnosticReport = {
      clientId: this.clientId,
      measurements: this.completed
        .slice(0, 32)
        .map((sample) => this.withResourceTiming(sample)),
    };
    if (
      navigator.sendBeacon?.(
        `${this.sessionUrl}/diagnostics`,
        new Blob([JSON.stringify(report)], { type: "application/json" }),
      )
    )
      this.completed.splice(0, report.measurements.length);
    if (this.completed.length) this.scheduleFlush();
  }

  private take(count: number): RequestMeasurement[] {
    const reports: RequestMeasurement[] = [];
    this.completed = this.completed.filter((sample) => {
      if (reports.length >= count) return true;
      const report = this.withResourceTiming(sample);
      if (
        this.observer &&
        report.protocol === undefined &&
        performance.now() - sample.finished < 1_000
      )
        return true;
      reports.push(report);
      return false;
    });
    return reports;
  }

  close(): void {
    this.flush();
    this.observer?.disconnect();
    this.observer = undefined;
  }

  private observeResources(): void {
    if (
      this.observer ||
      typeof PerformanceObserver === "undefined" ||
      !PerformanceObserver.supportedEntryTypes.includes("resource")
    )
      return;
    const prefix =
      new URL(this.sessionUrl, `${location.protocol}//${location.host}`).href +
      "/";
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name.startsWith(prefix))
          this.resources.push(entry as PerformanceResourceTiming);
      }
      this.resources = this.resources.slice(-128);
    });
    this.observer.observe({ type: "resource" });
  }

  private withResourceTiming(
    sample: (typeof this.completed)[number],
  ): RequestMeasurement {
    const entry = this.resources
      .slice()
      .reverse()
      .find(
        (entry) =>
          entry.name === sample.url &&
          entry.startTime >= sample.started &&
          entry.responseEnd <= sample.finished,
      );
    if (!entry || !entry.requestStart || !entry.responseStart)
      return sample.value;
    return { ...sample.value, ...resourcePhases(entry, sample.finished) };
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = window.setTimeout(() => this.flush(), 10_000);
  }
}

export function resourcePhases(
  entry: Pick<
    PerformanceResourceTiming,
    | "startTime"
    | "requestStart"
    | "responseStart"
    | "responseEnd"
    | "domainLookupStart"
    | "domainLookupEnd"
    | "connectStart"
    | "connectEnd"
    | "nextHopProtocol"
  >,
  finished: number,
) {
  return {
    setupMs: Math.max(0, entry.requestStart - entry.startTime),
    dnsMs: Math.max(0, entry.domainLookupEnd - entry.domainLookupStart),
    connectMs: Math.max(0, entry.connectEnd - entry.connectStart),
    firstByteMs: Math.max(0, entry.responseStart - entry.requestStart),
    transferMs: Math.max(0, entry.responseEnd - entry.responseStart),
    afterResponseMs: Math.max(0, finished - entry.responseEnd),
    protocol: entry.nextHopProtocol.slice(0, 32),
  };
}
