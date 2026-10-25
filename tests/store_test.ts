// Store rules that need KV but not a whole server: who gets to reuse a server name, and
// that no tale starts without Claude to play the wolf.

import { keys, Store } from "../server/store.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

async function withStore(fn: (store: Store) => Promise<void>, problem: string | null = null) {
  const dir = await Deno.makeTempDir();
  const kv = await Deno.openKv(`${dir}/global-kv.sqlite3`);
  try {
    await fn(new Store(kv, { answerMs: 60_000, discussMs: 60_000, voteMs: 60_000 }, problem));
  } finally {
    kv.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("an abandoned tale gives its name back: the next friend starts a fresh cottage", async () => {
  await withStore(async (store) => {
    const { slug } = await store.join("Old Woods", "Ann");
    await store.mutate(slug, (room) => room && { room: { ...room, phase: "reveal" }, drafts: [] });
    for await (const e of store.kv.list({ prefix: keys.presence(slug) })) await store.kv.delete(e.key);

    await store.join("old woods", "Bo");
    const room = (await store.room(slug))!;
    assert(room.phase === "lobby", `phase ${room.phase}`);
    assert(room.game === 2, "a new game number keeps the old tale's messages out");
    assert(room.players.length === 1 && room.players[0].name === "Bo", "only the newcomer is at the cottage");
  });
});

Deno.test("a tale with someone still there keeps its name", async () => {
  await withStore(async (store) => {
    const { slug } = await store.join("Old Woods", "Ann");
    await store.mutate(slug, (room) => room && { room: { ...room, phase: "answer" }, drafts: [] });

    const err = await store.join("Old Woods", "Bo").then(() => null, (e) => e);
    assert(err?.status === 409, `expected 409, got ${err}`);
    assert((await store.room(slug))!.players[0].name === "Ann");
  });
});

Deno.test("without Claude no tale starts, and the reason says why", async () => {
  await withStore(async (store) => {
    const ann = await store.join("Old Woods", "Ann");
    await store.join("Old Woods", "Bo");

    const err = await store.act(ann.slug, ann.token, { type: "start" }).then(() => null, (e) => e);
    assert(err?.status === 503, `expected 503, got ${err}`);
    assert(String(err.message).includes("no Anthropic API key"), err.message);
    assert((await store.room(ann.slug))!.phase === "lobby");
  }, "Claude isn't connected: there's no Anthropic API key in server/keys.ts.");
});
