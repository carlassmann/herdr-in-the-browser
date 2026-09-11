import { join } from "node:path";
import type { BunRequest, Server } from "bun";
import type {
  ClientMessage,
  ServerMessage,
  SessionMode,
} from "../shared/protocol";
import homepage from "../client/index.html";
import { loadGhosttyAppearance, loadGhosttyFont } from "./ghostty-config";
import { isClientMessage } from "./session";
import { SessionManager } from "./session-manager";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const development = process.env.NODE_ENV !== "production";
const publicDirectory = join(process.cwd(), "public");
const sessions = new SessionManager();

interface SocketData {
  sessionName: string;
  cursor: number;
  unsubscribe?: () => void;
}

const server = Bun.serve<SocketData>({
  hostname: host,
  port,
  idleTimeout: 0,
  development: development ? { hmr: true, console: false } : false,
  routes: {
    "/": homepage,
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
      GET: guard(async () => json(await loadGhosttyAppearance())),
    },
    "/api/appearance/font": {
      GET: fontRoute("regular"),
    },
    "/api/appearance/font/bold": {
      GET: fontRoute("bold"),
    },
    "/api/appearance/font/italic": {
      GET: fontRoute("italic"),
    },
    "/api/appearance/font/bold-italic": {
      GET: fontRoute("bold-italic"),
    },
    "/api/sessions": {
      GET: guard(async () => json({ sessions: await sessions.list() })),
      POST: guard(async (request: BunRequest<"/api/sessions">) => {
        try {
          const body = (await request.json()) as {
            name?: unknown;
            mode?: unknown;
          };
          const name = typeof body.name === "string" ? body.name.trim() : "";
          const mode: SessionMode =
            body.mode === "attach" ? "attach" : "create";
          return json({ session: sessions.open(name, mode).summary() }, 201);
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error ? error.message : "Invalid request.",
            },
            400,
          );
        }
      }),
    },
    "/api/session/:id/ws": {
      GET: guard(function (
        request: BunRequest<"/api/session/:id/ws">,
        server: Server<SocketData>,
      ) {
        const sessionName = request.params.id;
        if (!sessions.get(sessionName))
          return json({ error: "Session not found." }, 404);
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
          return json({ error: "WebSocket upgrade required." }, 426);
        const cursor = readCursor(request);
        if (server.upgrade(request, { data: { sessionName, cursor } })) return;
        return json({ error: "WebSocket upgrade failed." }, 400);
      }),
    },
    "/api/session/:id/events": {
      GET: guard(function (request: BunRequest<"/api/session/:id/events">) {
        const session = sessions.get(request.params.id);
        if (!session) return json({ error: "Session not found." }, 404);

        let unsubscribe = () => {};
        let keepAlive: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream({
          start(controller) {
            const send = (message: ServerMessage) => {
              controller.enqueue(`data: ${JSON.stringify(message)}\n\n`);
            };
            unsubscribe = session.subscribe(send, readCursor(request));
            keepAlive = setInterval(
              () => controller.enqueue(": keepalive\n\n"),
              15_000,
            );
          },
          cancel() {
            unsubscribe();
            if (keepAlive) {
              clearInterval(keepAlive);
            }
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        });
      }),
    },
    "/api/session/:id/input": {
      POST: guard((request: BunRequest<"/api/session/:id/input">) =>
        receiveSessionMessage(request, "input"),
      ),
    },
    "/api/session/:id/resize": {
      POST: guard((request: BunRequest<"/api/session/:id/resize">) =>
        receiveSessionMessage(request, "resize"),
      ),
    },
    "/api/session/:id": {
      DELETE: guard(async (request: BunRequest<"/api/session/:id">) => {
        try {
          await sessions.stop(request.params.id);
          return new Response(null, { status: 204 });
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Could not stop session.",
            },
            400,
          );
        }
      }),
    },
    "/api/*": guard(() => json({ error: "Not found." }, 404)),
  },
  fetch() {
    return new Response("Not found.", { status: 404 });
  },
  websocket: {
    open(socket) {
      const session = sessions.get(socket.data.sessionName);
      if (!session) return socket.close(1008, "Session not found");
      socket.data.unsubscribe = session.subscribe(
        (message) => socket.send(JSON.stringify(message)),
        socket.data.cursor,
      );
    },
    message(socket, raw) {
      const session = sessions.get(socket.data.sessionName);
      if (!session) return;
      try {
        const message: unknown = JSON.parse(
          typeof raw === "string" ? raw : Buffer.from(raw).toString(),
        );
        if (isClientMessage(message)) session.receive(message);
      } catch {
        socket.close(1003, "Invalid message");
      }
    },
    close(socket) {
      socket.data.unsubscribe?.();
    },
  },
});

console.log(`Herdr Web Terminal listening on http://${host}:${server.port}`);

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function guard<T extends Request, Args extends unknown[]>(
  handler: (
    request: T,
    ...args: Args
  ) => Response | void | Promise<Response | void>,
) {
  return (request: T, ...args: Args) =>
    isSameOrigin(request)
      ? handler(request, ...args)
      : json({ error: "Cross-origin request rejected." }, 403);
}

function fontRoute(variant: "regular" | "bold" | "italic" | "bold-italic") {
  return guard(async () => {
    const font = await loadGhosttyFont(variant);
    if (!font)
      return json({ error: "Configured Ghostty font not found." }, 404);
    return new Response(font.file, {
      headers: {
        "Content-Type": font.contentType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  });
}

async function receiveSessionMessage(
  request: Request & { params: { id: string } },
  type: "input" | "resize",
): Promise<Response> {
  const session = sessions.get(request.params.id);
  if (!session) return json({ error: "Session not found." }, 404);
  const body: unknown = await request.json();
  if (!isClientMessage(body) || body.type !== type)
    return json({ error: "Invalid message." }, 400);
  session.receive(body);
  return new Response(null, { status: 204 });
}

function readCursor(request: Request): number {
  const value = Number(new URL(request.url).searchParams.get("cursor") ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

function staticFile(name: string, headers: Record<string, string>) {
  return new Response(Bun.file(join(publicDirectory, name)), { headers });
}
