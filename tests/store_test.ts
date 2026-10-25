// Store rules that need KV but not a whole server: who gets to reuse a server name, that
// no tale starts without Claude to play the wolf, and where each tale's questions come from.

import { LAST_QUESTION, QUESTION_POOL } from "../server/cast.ts";
import { keys, type QuestionWriter, Store } from "../server/store.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

async function withStore(
  fn: (store: Store) => Promise<void>,
  problem: string | null = null,
  writer: QuestionWriter | null = null,
) {
  const dir = await Deno.makeTempDir();
  const kv = await Deno.openKv(`${dir}/global-kv.sqlite3`);
  try {
    await fn(new Store(kv, { answerMs: 60_000, discussMs: 60_000, voteMs: 60_000 }, problem, writer));
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
    assert(String(err.message).includes("ANTHROPIC_API_KEY"), err.message);
    assert((await store.room(ann.slug))!.phase === "lobby");
  }, "Claude isn't connected: ANTHROPIC_API_KEY isn't set on this server.");
});

/** Two friends at a fresh cottage, both here. */
async function twoAtTheDoor(store: Store) {
  const ann = await store.join("Old Woods", "Ann");
  const bo = await store.join("Old Woods", "Bo");
  return { ann, bo };
}

Deno.test("the wolf's model writes each tale's questions, and hears which ones this server already had", async () => {
  const asked: string[][] = [];
  let tale = 0;
  const writer: QuestionWriter = (recent) => {
    asked.push(recent);
    tale++;
    return Promise.resolve([`fridge rn ${tale}`, `regret ${tale}`, `prove it ${tale}. go`]);
  };
  await withStore(
    async (store) => {
      const { ann } = await twoAtTheDoor(store);
      await store.act(ann.slug, ann.token, { type: "start" });
      let room = (await store.room(ann.slug))!;
      assert(JSON.stringify(room.questions) === JSON.stringify(["fridge rn 1", "regret 1", "prove it 1. go"]));

      // Read it again: the next tale's writer is told what this server has already answered.
      await store.mutate(ann.slug, (r) => r && { room: { ...r, phase: "reveal" }, drafts: [] });
      await store.act(ann.slug, ann.token, { type: "again" });
      await store.act(ann.slug, ann.token, { type: "start" });
      room = (await store.room(ann.slug))!;
      assert(room.questions[0] === "fridge rn 2");
      assert(JSON.stringify(asked) === JSON.stringify([[], ["fridge rn 1", "regret 1", "prove it 1. go"]]));
    },
    null,
    writer,
  );
});

Deno.test("when the model can't write questions, the tale starts on the fixed list", async () => {
  const writer: QuestionWriter = () => Promise.reject(new Error("Claude didn't answer within 12s."));
  await withStore(
    async (store) => {
      const { ann } = await twoAtTheDoor(store);
      await store.act(ann.slug, ann.token, { type: "start" });
      const room = (await store.room(ann.slug))!;
      assert(room.phase === "warmup", `phase ${room.phase}`); // the tale opens on the warm-up chat
      assert(room.questions.slice(0, 2).every((q) => QUESTION_POOL.includes(q)), JSON.stringify(room.questions));
      assert(room.questions[2] === LAST_QUESTION);
    },
    null,
    writer,
  );
});

Deno.test("no questions are paid for when the tale can't start", async () => {
  let calls = 0;
  const writer: QuestionWriter = () => {
    calls++;
    return Promise.resolve(["a question", "another question", "prove it. go"]);
  };
  const status = (p: Promise<unknown>) => p.then(() => 200, (e) => e.status);
  await withStore(
    async (store) => {
      const ann = await store.join("Old Woods", "Ann");
      assert(await status(store.act(ann.slug, ann.token, { type: "start" })) === 409, "alone at the door");
      const bo = await store.join("Old Woods", "Bo");
      assert(await status(store.act(bo.slug, bo.token, { type: "start" })) === 403, "not the host");
      assert(calls === 0, `${calls} calls`);
    },
    null,
    writer,
  );
  await withStore(
    async (store) => {
      const { ann } = await twoAtTheDoor(store);
      assert(await status(store.act(ann.slug, ann.token, { type: "start" })) === 503, "no wolf");
      assert(calls === 0, `${calls} calls`);
    },
    "Claude isn't connected: ANTHROPIC_API_KEY isn't set on this server.",
    writer,
  );
});

Deno.test("two friends joining at the same moment both stay at the cottage", async () => {
  await withStore(async (store) => {
    const ann = await store.join("Old Woods", "Ann");
    // Bo's join reads who's here before Ann's page has connected (her presence isn't recorded yet).
    await store.kv.delete([...keys.presence(ann.slug), (await store.room(ann.slug))!.players[0].id]);
    await store.join("Old Woods", "Bo");
    const names = (await store.room(ann.slug))!.players.map((p) => p.name);
    assert(JSON.stringify(names) === JSON.stringify(["Ann", "Bo"]), `players: ${names}`);
  });
});
