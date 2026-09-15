import { join } from "node:path";
import type { BunRequest, HTMLBundle, Server, ServerWebSocket } from "bun";
import {
  INPUT_SEQUENCE_HEADER,
  INPUT_STREAM_HEADER,
  isClientMessage,
  parseAttachQuery,
  timing,
  type AttachOptions,
  type ServerMessage,
  type SessionMode,
  type SessionSummary,
} from "../shared/protocol";
import { loadGhosttyAppearance, loadGhosttyFont } from "./ghostty-config";
import { isTrustedRequest } from "./request-origin";
import { collectMessages } from "./long-poll";
import type { InputOrdering, TerminalSession } from "./session";

export interface SessionRegistry {
  get(id: string): TerminalSession | undefined;
  open(name: string, mode: SessionMode): TerminalSession;
  stop(name: string): Promise<void>;
  list(): Promise<SessionSummary[]>;
}

export interface ServerDependencies {
  sessions: SessionRegistry;
  publicHosts: string[];
  publicDirectory: string;
  // The bundled client page, or any response standing in for it.
  homepage: HTMLBundle | Response;
}

interface SocketData {
  sessionName: string;
  attach: AttachOptions;
  detach?: () => void;
}

const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024;

type RouteHandler = (
  request: BunRequest,
  server: Server<SocketData>,
) => Response | void | Promise<Response | void>;

// Builds the routes and WebSocket handlers for Bun.serve. Every route except
// the page itself refuses requests whose Host or Origin is not ours: this app
// has no accounts, so the allowlist is the only thing between a DNS-rebinding
// page and a shell.
export function serverRoutes({
  sessions,
  publicHosts,
  publicDirectory,
  homepage,
}: ServerDependencies) {
  const trusted = (request: Request) =>
    isTrustedRequest(
      {
        host: request.headers.get("host"),
        origin: request.headers.get("origin"),
      },
      publicHosts,
    );

  const routes = {
    "/manifest.webmanifest": staticFile("manifest.webmanifest", {
      "Content-Type": "application/manifest+json",
    }),
    "/sw.js": staticFile("sw.js", {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/",
    }),
    "/terminal.svg": staticFile("terminal.svg", {
      "Content-Type": "image/svg+xml",
    }),
    "/terminal-180.png": staticFile("terminal-180.png", {
      "Content-Type": "image/png",
    }),
    "/api/appearance": {
      GET: async () => json(await loadGhosttyAppearance()),
    },
    "/api/appearance/font": { GET: fontRoute("regular") },
    "/api/appearance/font/bold": { GET: fontRoute("bold") },
    "/api/appearance/font/italic": { GET: fontRoute("italic") },
    "/api/appearance/font/bold-italic": { GET: fontRoute("bold-italic") },
    "/api/sessions": {
      GET: async () => json({ sessions: await sessions.list() }),
      POST: async (request: BunRequest<"/api/sessions">) => {
        try {
          const body = ((await readJson(request)) ?? {}) as {
            name?: unknown;
            mode?: unknown;
          };
          const name = typeof body.name === "string" ? body.name.trim() : "";
          const mode: SessionMode =
            body.mode === "attach" ? "attach" : "create";
          return json({ session: sessions.open(name, mode).summary() }, 201);
        } catch (error) {
          return json({ error: errorMessage(error, "Invalid request.") }, 400);
        }
      },
    },
    "/api/session/:id/ws": {
      GET: (
        request: BunRequest<"/api/session/:id/ws">,
        server: Server<SocketData>,
      ) => {
        const sessionName = request.params.id;
        if (!sessions.get(sessionName))
          return json({ error: "Session not found." }, 404);
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
          return json({ error: "WebSocket upgrade required." }, 426);
        const data: SocketData = {
          sessionName,
          attach: parseAttachQuery(new URL(request.url).searchParams),
        };
        if (server.upgrade(request, { data })) return;
        return json({ error: "WebSocket upgrade failed." }, 400);
      },
    },
    "/api/session/:id/events": {
      GET: (request: BunRequest<"/api/session/:id/events">) => {
        const session = sessions.get(request.params.id);
        if (!session) return json({ error: "Session not found." }, 404);
        const attach = parseAttachQuery(new URL(request.url).searchParams);

        let detach = () => {};
        let keepAlive: ReturnType<typeof setInterval> | undefined;
        let active = true;
        const stream = new ReadableStream(
          {
            start(controller) {
              const finish = () => {
                if (!active) return;
                active = false;
                detach();
                clearInterval(keepAlive);
                controller.close();
              };
              const send = (message: ServerMessage) => {
                if (!active) return;
                if ((controller.desiredSize ?? 0) <= 0) return finish();
                controller.enqueue(`data: ${JSON.stringify(message)}\n\n`);
                // Let attach finish its synchronous status, sync and replay first.
                if (message.type === "status" && !message.running)
                  queueMicrotask(finish);
              };
              detach = session.attach(send, attach);
              if (!active) detach();
              if (active && session.isRunning())
                keepAlive = setInterval(
                  () => send({ type: "status", running: session.isRunning() }),
                  timing.sseKeepAliveMs,
                );
              if (!session.isRunning()) queueMicrotask(finish);
            },
            cancel() {
              active = false;
              detach();
              clearInterval(keepAlive);
            },
          },
          {
            highWaterMark: MAX_CLIENT_BUFFER_BYTES,
            size: (chunk) => Buffer.byteLength(chunk),
          },
        );
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        });
      },
    },
    "/api/session/:id/poll": {
      GET: async (request: BunRequest<"/api/session/:id/poll">) => {
        const session = sessions.get(request.params.id);
        if (!session) return json({ error: "Session not found." }, 404);
        const attach = parseAttachQuery(new URL(request.url).searchParams);
        return json({
          messages: await collectMessages(session, attach, {
            timeoutMs: timing.longPollTimeoutMs,
            signal: request.signal,
            maxBytes: MAX_CLIENT_BUFFER_BYTES,
          }),
        });
      },
    },
    "/api/session/:id/input": {
      POST: (request: BunRequest<"/api/session/:id/input">) =>
        receiveSessionMessage(request, "input"),
    },
    "/api/session/:id/resize": {
      POST: (request: BunRequest<"/api/session/:id/resize">) =>
        receiveSessionMessage(request, "resize"),
    },
    "/api/session/:id": {
      DELETE: async (request: BunRequest<"/api/session/:id">) => {
        try {
          await sessions.stop(request.params.id);
          return new Response(null, { status: 204 });
        } catch (error) {
          return json(
            { error: errorMessage(error, "Could not stop session.") },
            400,
          );
        }
      },
    },
    "/api/*": () => json({ error: "Not found." }, 404),
  };

  async function receiveSessionMessage(
    request: BunRequest<"/api/session/:id/input" | "/api/session/:id/resize">,
    type: "input" | "resize",
  ): Promise<Response> {
    const session = sessions.get(request.params.id);
    if (!session) return json({ error: "Session not found." }, 404);
    const body = await readJson(request);
    if (!isClientMessage(body) || body.type !== type)
      return json({ error: "Invalid message." }, 400);
    try {
      await session.receive(body, readInputOrdering(request));
    } catch {
      return json({ error: "Input stream interrupted. Reconnect." }, 409);
    }
    return new Response(null, { status: 204 });
  }

  function fontRoute(variant: "regular" | "bold" | "italic" | "bold-italic") {
    return async () => {
      const font = await loadGhosttyFont(variant);
      if (!font)
        return json({ error: "Configured Ghostty font not found." }, 404);
      return new Response(font.file, {
        headers: {
          "Content-Type": font.contentType,
          "Cache-Control": "private, max-age=3600",
        },
      });
    };
  }

  function staticFile(name: string, headers: Record<string, string>) {
    return () =>
      new Response(Bun.file(join(publicDirectory, name)), { headers });
  }

  return {
    routes: {
      "/": homepage,
      ...guardRoutes(routes, trusted),
    },
    fetch() {
      return new Response("Not found.", { status: 404 });
    },
    websocket: {
      open(socket: ServerWebSocket<SocketData>) {
        const session = sessions.get(socket.data.sessionName);
        if (!session) return socket.close(1008, "Session not found");
        let active = true;
        socket.data.detach = session.attach((message) => {
          if (!active) return;
          if (socket.getBufferedAmount() >= MAX_CLIENT_BUFFER_BYTES) {
            active = false;
            socket.data.detach?.();
            socket.close(1013, "Client fell behind; reconnect to replay");
            return;
          }
          if (socket.send(JSON.stringify(message)) === 0) {
            active = false;
            socket.data.detach?.();
            socket.close(1011, "Output send failed; reconnect to replay");
          }
        }, socket.data.attach);
        if (!active) socket.data.detach();
      },
      message(socket: ServerWebSocket<SocketData>, raw: string | Buffer) {
        const session = sessions.get(socket.data.sessionName);
        if (!session) return;
        try {
          const message: unknown = JSON.parse(
            typeof raw === "string" ? raw : Buffer.from(raw).toString(),
          );
          if (isClientMessage(message)) void session.receive(message);
        } catch {
          socket.close(1003, "Invalid message");
        }
      },
      close(socket: ServerWebSocket<SocketData>) {
        socket.data.detach?.();
      },
    },
  };
}

// Wraps every handler, whether a route is one function or a set of methods,
// so a route added later is protected without remembering to ask.
function guardRoutes<Routes extends Record<string, unknown>>(
  routes: Routes,
  trusted: (request: Request) => boolean,
): Routes {
  const refuse = () => json({ error: "Untrusted request origin." }, 403);
  const guard = (handler: RouteHandler): RouteHandler =>
    function guarded(request, server) {
      return trusted(request) ? handler(request, server) : refuse();
    };
  const guarded: Record<string, unknown> = {};
  for (const [path, route] of Object.entries(routes)) {
    if (typeof route === "function") {
      guarded[path] = guard(route as RouteHandler);
    } else if (route && typeof route === "object") {
      guarded[path] = Object.fromEntries(
        Object.entries(route).map(([method, handler]) => [
          method,
          guard(handler as RouteHandler),
        ]),
      );
    } else {
      guarded[path] = route;
    }
  }
  return guarded as Routes;
}

function readInputOrdering(request: Request): InputOrdering | undefined {
  const stream = request.headers.get(INPUT_STREAM_HEADER);
  const sequence = request.headers.get(INPUT_SEQUENCE_HEADER);
  if (stream === null || sequence === null) return undefined;
  return { stream, sequence: Number(sequence) };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
