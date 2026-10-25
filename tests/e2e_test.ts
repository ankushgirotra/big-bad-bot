// A whole tale over real HTTP + SSE: three friends and the wolf (against a fake Claude
// Messages API), on a throwaway KV file, with short candles and a fast wolf. Then: what the
// players see when Claude fails, or isn't connected at all.

import { startServer } from "../server/app.ts";
import { castOf, type Msg, type View } from "../server/game.ts";
import { NS } from "../server/kv.ts";
import { fakeClaude } from "./fake_claude.ts";
import { WOLF_MODELS } from "../server/wolf.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

type Event = { view: View; msgs: Msg[]; reset: boolean };

/** A player's browser, minus the browser: follows the SSE stream and keeps the log. */
class Client {
  view?: View;
  log: Msg[] = [];
  #abort = new AbortController();

  constructor(readonly url: string, readonly slug: string, readonly token: string, readonly name: string) {
    void this.#follow();
  }

  async #follow() {
    try {
      const res = await fetch(`${this.url}/api/events?server=${this.slug}&token=${this.token}`, {
        signal: this.#abort.signal,
      });
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += value;
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(chunk)?.[1];
          const data = /^data: (.*)$/m.exec(chunk)?.[1];
          if (event !== "view" || !data) continue;
          const e: Event = JSON.parse(data);
          if (e.reset) this.log = [];
          this.log.push(...e.msgs);
          this.view = e.view;
        }
      }
    } catch (err) {
      if (!this.#abort.signal.aborted) throw err;
    }
  }

  async until(what: string, pred: (v: View) => boolean, ms = 15_000): Promise<View> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.view && pred(this.view)) return this.view;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `${this.name}: timed out waiting for ${what}; last view ${JSON.stringify(this.view)?.slice(0, 400)}`,
    );
  }

  close() {
    this.#abort.abort();
  }
}

type Act = (c: Client, type: string, extra?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>;

/** Everyone chats three lines with the wolf (it answers each) and says they're ready. */
async function warmUp(clients: Client[], act: Act) {
  for (const c of clients) {
    for (let i = 0; i < 3; i++) {
      for (let n = 0; n < 60; n++) {
        const r = await act(c, "warm", { text: `lol ${c.name.toLowerCase()} said thing ${i}` });
        if (r.status === 200) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await c.until("the wolf's reply", (v) => v.phase !== "warmup" || v.warm!.lines.length >= 2 * (i + 1) + 1);
    }
    assert((await act(c, "ready")).status === 200);
  }
}

Deno.test({
  name: "a whole tale: join, three chapters, questioning the wolf, the vote, the reveal, again",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir();
    const kv = await Deno.openKv(`${dir}/global-kv.sqlite3`);
    const claude = fakeClaude();
    // Another project's key in the same shared database must survive untouched.
    await kv.set(["some-other-project", "hello"], "world");
    const app = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      timing: { warmupMs: 20_000, answerMs: 6_000, discussMs: 6_000, voteMs: 6_000 },
      wolfPace: 0.02,
      claude: { apiKey: "test", model: "", baseURL: claude.url, effort: "low" },
      kv,
      quiet: true,
    });
    const clients: Client[] = [];
    const post = async (path: string, body: unknown) => {
      const res = await fetch(app.url + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    };

    try {
      // ---- page 1: pick a server and a name
      const joined = [];
      for (const name of ["Ankush", "Bea", "Cy"]) {
        const { status, data } = await post("/api/join", { server: "Grandma's House", name });
        assert(status === 200, `join ${name}: ${JSON.stringify(data)}`);
        assert(data.slug === "grandmas-house");
        joined.push({ ...data, name });
      }
      const dup = await post("/api/join", { server: "grandmas-house", name: "bea" });
      assert(dup.status === 409, "a name that's here can't be taken twice");

      const listed = await (await fetch(`${app.url}/api/servers`)).json();
      assert(
        listed.servers.some((s: { slug: string; players: number }) => s.slug === "grandmas-house" && s.players === 3),
      );
      assert(listed.cast.length === 8);

      // ---- page 2: everyone opens the tale
      for (const j of joined) clients.push(new Client(app.url, j.slug, j.token, j.name));
      const [host, bea, cy] = clients;
      for (const c of clients) await c.until("the lobby", (v) => v.phase === "lobby" && v.players.length === 3);
      assert(host.view!.you.host && !bea.view!.you.host, "the first to arrive leads the way");

      const act = (c: Client, type: string, extra: Record<string, unknown> = {}) =>
        post("/api/act", { server: c.slug, token: c.token, type, ...extra });

      assert((await act(bea, "start")).status === 403, "only the host starts");
      assert((await act(host, "start")).status === 200);
      for (const c of clients) await c.until("the warm-up", (v) => v.phase === "warmup");

      // ---- the warm-up: a private chat with the wolf before the path begins
      assert((await act(bea, "say", { text: "hi" })).status === 409, "no public chat during the warm-up");
      for (const c of clients) {
        assert(c.view!.warm!.lines.length === 1 && c.view!.warm!.lines[0].from === "wolf", "the wolf opens");
      }
      await warmUp(clients, act);
      for (const c of clients) await c.until("chapter one", (v) => v.phase === "answer" && v.chapter === 0);
      for (const c of clients) assert(c.view!.warm === null, "the chat is gone once the path begins");
      const mid = (await app.store.room("grandmas-house"))!;
      for (const p of mid.players) {
        assert(mid.warmup[p.id].length === 7, `${p.name}'s chat: ${mid.warmup[p.id].length} lines`);
        assert(mid.warmup[p.id].at(-1)!.from === "wolf", "the wolf had the last word");
      }

      const late = await post("/api/join", { server: "grandmas-house", name: "Dee" });
      assert(late.status === 409, "no joining mid-tale");

      // Mid-tale views never carry other players' real names.
      for (const c of clients) {
        const seen = JSON.stringify(c.view);
        for (const other of clients.filter((o) => o !== c)) {
          assert(!seen.includes(`"${other.name}"`), `${c.name} can see ${other.name}'s name`);
        }
        assert(c.view!.you.seat >= 0);
      }
      const room = (await app.store.room("grandmas-house"))!;
      const wolfName = castOf(room, room.wolfSeat).name;

      // ---- three chapters
      for (let ch = 0; ch < 3; ch++) {
        for (const c of clients) {
          const r = await act(c, "say", { text: `${c.name.toLowerCase()} answer ${ch}` });
          assert(r.status === 200, `answer: ${JSON.stringify(r.data)}`);
        }
        // The wolf answers by itself, which opens the discussion.
        for (const c of clients) await c.until(`discussion ${ch}`, (v) => v.phase === "discuss" && v.chapter === ch);
        const answers = host.log.filter((m) => m.kind === "answer" && m.chapter === ch);
        assert(answers.length === 4, `four answers in chapter ${ch}, got ${answers.length}`);
        assert(answers.some((m) => m.seat === room.wolfSeat), "the wolf answered");

        if (ch === 1) {
          // Question the wolf by name; it should answer back.
          await act(cy, "say", { text: `@${wolfName} kinda sus ngl. explain` });
          await cy.until(
            "the wolf's reply",
            () => cy.log.some((m) => m.kind === "chat" && m.chapter === 1 && m.seat === room.wolfSeat),
          );
        }
        if (ch < 2) {
          await act(bea, "onward");
          assert(bea.view!.phase === "discuss" || bea.view!.chapter === ch, "one ask of three isn't a majority");
          await act(host, "onward");
          for (const c of clients) await c.until(`chapter ${ch + 1}`, (v) => v.chapter === ch + 1);
        }
      }

      // ---- knock on grandma's door (a majority of two)
      await act(bea, "early");
      await act(cy, "early");
      for (const c of clients) await c.until("the vote", (v) => v.phase === "vote");
      for (const c of clients) assert((await act(c, "vote", { target: room.wolfSeat })).status === 200);

      // ---- the reveal
      const end = await host.until("the reveal", (v) => v.phase === "reveal");
      assert(end.result!.humansWin, "three votes for the wolf catch it");
      assert(end.result!.wolfSeat === room.wolfSeat);
      assert(end.result!.tells.length >= 3, "tells are computed");
      assert(end.result!.votes.length === 4, "the wolf voted too");
      const names = end.seats.map((s) => s.player).filter(Boolean).sort();
      assert(JSON.stringify(names) === JSON.stringify(["Ankush", "Bea", "Cy"]), `unmasked: ${names}`);

      // ---- read it again
      await act(cy, "again");
      const fresh = await host.until("a new tale", (v) => v.phase === "lobby" && v.game === 2);
      assert(fresh.players.length === 3);
      assert(host.log.every((m) => m.kind === "sys"), "the new tale starts with a clean log");

      // ---- everything lives under the namespace in the shared database
      for await (const e of kv.list({ prefix: [] })) {
        assert(e.key[0] === NS[0] || e.key[0] === "some-other-project", `stray key ${JSON.stringify(e.key)}`);
      }
      assert((await kv.get(["some-other-project", "hello"])).value === "world");

      // ---- with WOLF_MODEL unset, the wolf only ever asked for Haiku
      assert(claude.calls > 0 && claude.models.every((m) => m === WOLF_MODELS.haiku.id), `models: ${claude.models}`);
    } finally {
      for (const c of clients) c.close();
      await app.close();
      await claude.close();
      kv.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/** Two friends at a fresh server, with the given Anthropic API key. */
async function twoFriends(
  apiKey: string,
  test: (t: {
    host: Client;
    guest: Client;
    claude: ReturnType<typeof fakeClaude>;
    act: (
      c: Client,
      type: string,
      extra?: Record<string, unknown>,
    ) => Promise<{ status: number; data: { error?: string } }>;
  }) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const kv = await Deno.openKv(`${dir}/global-kv.sqlite3`);
  const claude = fakeClaude();
  const app = await startServer({
    port: 0,
    hostname: "127.0.0.1",
    timing: { warmupMs: 20_000, answerMs: 20_000, discussMs: 20_000, voteMs: 20_000 },
    wolfPace: 0.02,
    claude: { apiKey, model: "", baseURL: claude.url, effort: "low" },
    kv,
    quiet: true,
  });
  const post = async (path: string, body: unknown) => {
    const res = await fetch(app.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const clients: Client[] = [];
  try {
    for (const name of ["Ann", "Bo"]) {
      const { data } = await post("/api/join", { server: "the-woods", name });
      clients.push(new Client(app.url, data.slug, data.token, name));
    }
    for (const c of clients) await c.until("the lobby", (v) => v.phase === "lobby" && v.players.length === 2);
    await test({
      host: clients[0],
      guest: clients[1],
      claude,
      act: (c, type, extra = {}) => post("/api/act", { server: c.slug, token: c.token, type, ...extra }),
    });
  } finally {
    for (const c of clients) c.close();
    await app.close();
    await claude.close();
    kv.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name: "when Claude fails, every player sees the error, and it clears once Claude answers again",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await twoFriends("test", async ({ host, guest, claude, act }) => {
      claude.failing = true;
      assert((await act(host, "start")).status === 200);
      for (const c of [host, guest]) await c.until("the warm-up", (v) => v.phase === "warmup");
      // The wolf can't answer in the warm-up chat: everyone is told why, and nothing stands in for it.
      assert((await act(host, "warm", { text: "hey" })).status === 200);
      for (const c of [host, guest]) {
        const v = await c.until("the wolf's error", (v) => v.wolfError !== null);
        assert(v.wolfError!.includes("HTTP 529") && v.wolfError!.includes("Overloaded"), v.wolfError!);
      }
      assert(
        host.view!.warm!.lines.length === 2 && host.view!.warm!.lines.at(-1)!.from === "you",
        "no made-up reply in the warm-up chat",
      );

      // Claude recovers: the wolf retries by itself, answers, and the error goes away.
      claude.failing = false;
      await host.until("the wolf's retry", (v) => v.warm !== null && v.warm.lines.length === 3 && v.wolfError === null);

      // On to the tale: the host sent one line already, the guest none; both finish with "ready".
      for (const c of [host, guest]) {
        for (let i = c === host ? 1 : 0; i < 3; i++) {
          for (let n = 0; n < 60; n++) {
            const r = await act(c, "warm", { text: `${c.name} says ${i}` });
            if (r.status === 200) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          await c.until("the wolf's reply", (v) => v.phase !== "warmup" || v.warm!.lines.length >= 2 * (i + 1) + 1);
        }
        assert((await act(c, "ready")).status === 200);
      }
      await host.until("chapter one", (v) => v.phase === "answer");
      for (const c of [host, guest]) await act(c, "say", { text: `${c.name} answer` });
      // With both friends in, the wolf tries again; this time Claude answers and the error goes away.
      const v = await host.until("the discussion", (v) => v.phase === "discuss");
      assert(v.wolfError === null, `error still showing: ${v.wolfError}`);
      assert(host.log.some((m) => m.kind === "answer" && m.text === "ok fair mine was kinda boring too"));
    });
  },
});

Deno.test({
  name: "without an Anthropic key the error shows from the lobby on, and no tale starts",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await twoFriends("", async ({ host, act, claude }) => {
      assert(host.view!.wolfError?.includes("no Anthropic API key"), `lobby view: ${host.view!.wolfError}`);
      const r = await act(host, "start");
      assert(r.status === 503 && r.data.error?.includes("server/keys.ts"), JSON.stringify(r));
      assert(claude.calls === 0);
    });
  },
});
