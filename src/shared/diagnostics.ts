export type DiagnosticOperation = "input" | "resize" | "poll";
export type DiagnosticTransport = "websocket" | "sse" | "poll";

export interface RequestMeasurement {
  id: string;
  operation: DiagnosticOperation;
  transport: DiagnosticTransport;
  status: number;
  requestMs: number;
  serverMs?: number;
  queueMs?: number;
  batchSize?: number;
  inputBytes?: number;
  outputBytes?: number;
  headersMs?: number;
  consumeMs?: number;
  setupMs?: number;
  dnsMs?: number;
  connectMs?: number;
  firstByteMs?: number;
  transferMs?: number;
  afterResponseMs?: number;
  protocol?: string;
}

export interface DiagnosticReport {
  clientId: string;
  measurements: RequestMeasurement[];
}
