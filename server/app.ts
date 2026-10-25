// HTTP: the two pages, a small JSON API, and a Server-Sent Events stream per
// player that pushes their view whenever the room's pulse key changes in KV.

import { CAST } from "./cast.ts";
import { openGlobalKv } from "./kv.ts";
import { GameError, type Msg, type Timing, viewFor } from "./game.ts";
import { slugify, Store } from "./store.ts";
import { KEYS } from "./keys.ts";
import { Brain, type ClaudeConfig, WolfPack } from "./wolf.ts";

export interface Config {
  port: number;
  hostname: string;
  timing: Timing;
  /** Multiplies every wolf delay. 1 feels human; tests use ~0.02. */
  wolfPace: number;
  claude: ClaudeConfig;
  /** Use this KV instead of opening global-kv (tests). */
  kv?: Deno.Kv;
  quiet?: boolean;
}

export function configFromEnv(env: Pick<Deno.Env, "get"> = Deno.env): Config {
  const num = (name: string, fallback: number) => {
    const v = Number(env.get(name));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    port: num("PORT", 8000),
    hostname: env.get("HOST") || "0.0.0.0",
    timing: {
      warmupMs: num("WARMUP_SECONDS", 120) * 1000,
      answerMs: num("ANSWER_SECONDS", 60) * 1000,
      discussMs: num("DISCUSS_SECONDS", 75) * 1000,
      voteMs: num("VOTE_SECONDS", 45) * 1000,
    },
    wolfPace: num("WOLF_PACE", 1),
    // The key comes only from server/keys.ts, so a key in someone's shell never bills another account.
    // WOLF_MODEL picks haiku (the default), sonnet or opus.
    claude: { apiKey: KEYS.anthropic.trim(), model: env.get("WOLF_MODEL") ?? "", effort: "medium" },
  };
}

const PUBLIC = new URL("../public/", import.meta.url);
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function file(name: string): Promise<Response> {
  try {
    const body = await Deno.readFile(new URL(name, PUBLIC));
    return new Response(body, {
      headers: {
        "content-type": TYPES[name.split(".").pop()!] ?? "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b : {};
  } catch {
    return {};
  }
}

export async function startServer(cfg: Config) {
  const opened = cfg.kv ? { kv: cfg.kv, where: "provided" } : await openGlobalKv();
  const kv = opened.kv;
  const brain = new Brain(cfg.claude);
  const store = new Store(kv, cfg.timing, brain.problem, (recent) => brain.questions(recent));
  const pack = new WolfPack(store, brain, cfg.wolfPace);
  const streams = new Set<() => void>();

  /** The player's live view: a full log on connect, then only new messages. */
  async function events(slug: string, token: string | null): Promise<Response> {
    const room = await store.room(slug);
    const player = room?.players.find((p) => p.token === token);
    if (!player) return json({ error: "You aren't part of this tale. Join from the front page." }, 401);

    const enc = new TextEncoder();
    let closed = false;
    let game = -1;
    let cursor: string | undefined;
    let reader: ReadableStreamDefaultReader<unknown> | undefined;
    let tickTimer: ReturnType<typeof setTimeout> | undefined;
    let beat: ReturnType<typeof setInterval> | undefined;
    let running: Promise<void> | null = null;
    let again = false;

    const close = () => {
      if (closed) return;
      closed = true;
      streams.delete(close);
      clearTimeout(tickTimer);
      clearInterval(beat);
      reader?.cancel().catch(() => {});
      pack.detach(slug);
      try {
        ctrl?.close();
      } catch { /* already closed */ }
    };
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
    const send = (event: string, data: unknown) => {
      if (!closed) ctrl?.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    };

    const push = async () => {
      const room = await store.room(slug);
      const me = room?.players.find((p) => p.id === player.id);
      if (!room || !me) {
        send("gone", { reason: room ? "You left this server." : "This server has gone quiet." });
        return close();
      }
      const reset = room.game !== game;
      if (reset) [game, cursor] = [room.game, undefined];
      const msgs: Msg[] = await store.messages(slug, room.game, cursor);
      if (msgs.length) cursor = msgs[msgs.length - 1].id;
      const [online, typing] = await Promise.all([store.online(slug), store.typingSeats(slug)]);
      online.add(player.id);
      const view = viewFor(room, me.id, online, typing, Date.now());
      // A server without Claude can't play the wolf at all; say so on every page, not just at the start.
      view.wolfError ??= brain.problem;
      send("view", { view, msgs, reset });
      // Whoever is connected when a candle burns out moves the tale on (it's idempotent).
      clearTimeout(tickTimer);
      if (room.deadline !== null) {
        tickTimer = setTimeout(() => store.tick(slug).catch(warn), Math.max(0, room.deadline - Date.now()) + 300);
      }
    };
    // One push at a time; a change that lands mid-push triggers one more.
    const refresh = () => {
      if (running) {
        again = true;
        return;
      }
      running = (async () => {
        do {
          again = false;
          try {
            await push();
          } catch (err) {
            warn(err);
          }
        } while (again && !closed);
        running = null;
      })();
    };
    const warn = (err: unknown) => {
      if (!closed) console.warn(`[sse ${slug}] ${err}`);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        streams.add(close);
        pack.attach(slug);
        store.touch(slug, player.id).catch(warn);
        reader = store.watch(slug).getReader();
        void (async () => {
          while (!closed) {
            const { done } = await reader!.read().catch(() => ({ done: true }));
            if (done) break;
            refresh();
          }
        })();
        // Heartbeat: keeps presence fresh, proxies awake, and clocks in sync.
        beat = setInterval(() => {
          store.touch(slug, player.id).catch(warn);
          refresh();
        }, 15_000);
      },
      cancel: close,
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }

  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "GET") {
        if (path === "/") return file("index.html");
        if (path === "/game") return file("game.html");
        if (/^\/[a-z0-9-]+\.(css|js|svg)$/.test(path)) return file(path.slice(1));
        if (path === "/api/health") {
          return json({ ok: !brain.problem, kv: opened.where, wolf: brain.label }, brain.problem ? 503 : 200);
        }
        if (path === "/api/servers") {
          return json({ servers: await store.servers(), cast: CAST, wolfError: brain.problem });
        }
        if (path === "/api/events") {
          return await events(slugify(url.searchParams.get("server")), url.searchParams.get("token"));
        }
      }
      if (req.method === "POST") {
        if (path === "/api/join") {
          const b = await body(req);
          return json(await store.join(b.server, b.name, b.token));
        }
        if (path === "/api/act") {
          const b = await body(req);
          await store.act(slugify(b.server), b.token, b);
          return json({ ok: true });
        }
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      if (err instanceof GameError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong in the woods." }, 500);
    }
  }

  const server = Deno.serve({
    port: cfg.port,
    hostname: cfg.hostname,
    onListen: ({ port }) => {
      if (cfg.quiet) return;
      console.log(`Big Bad Bot is listening on http://localhost:${port}`);
      console.log(`  kv:   ${opened.where} (keys under ["big-bad-bot"])`);
      if (brain.problem) console.error(`  wolf: ERROR ${brain.problem} No tale can start until it's set.`);
      else console.log(`  wolf: ${brain.label}`);
    },
  }, handler);

  return {
    server,
    store,
    kv,
    url: `http://localhost:${server.addr.port}`,
    async close() {
      for (const close of [...streams]) close();
      pack.closeAll();
      await server.shutdown();
      if (!cfg.kv) kv.close();
    },
  };
}
