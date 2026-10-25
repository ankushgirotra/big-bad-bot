import {
  again,
  castOf,
  castVote,
  computeTells,
  deliverable,
  type Draft,
  majority,
  mentions,
  type Msg,
  newPlayer,
  newRoom,
  proceed,
  type Room,
  say,
  seatOf,
  start,
  tick,
  viewFor,
  warmReady,
  warmReply,
  warmSamples,
  warmSay,
} from "../server/game.ts";
import { slugify } from "../server/store.ts";
import { anchorLines, driftWeight, effortFor, tidy } from "../server/wolf.ts";
import { describe, profile, restyle } from "../server/style.ts";

const T = { warmupMs: 120_000, answerMs: 60_000, discussMs: 75_000, voteMs: 45_000 };

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T, msg = "") {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`${msg} expected ${y}, got ${x}`);
}
function throwsStatus(fn: () => unknown, status: number) {
  try {
    fn();
  } catch (err) {
    eq((err as { status?: number }).status, status, "status");
    return;
  }
  throw new Error("expected a GameError");
}

/** Seeded rng so seats and questions are reproducible. */
function rng(seed = 42) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

function room(players = 3): Room {
  const ps = Array.from({ length: players }, (_, i) => newPlayer(`p${i}`, 0));
  const r = newRoom("test", ps[0], 0, "scripted");
  r.players = ps;
  return r;
}

/** A tale at the start of chapter one: the warm-up chat has run its course. */
function begun(players = 3): Room {
  const r = warming(players);
  tick(r, r.deadline!, T);
  return r;
}

/** A tale just started, in the warm-up chat. */
function warming(players = 3): Room {
  const r = room(players);
  start(r, true, 1_000, T, rng());
  return r;
}

const humanSeats = (r: Room) => r.seats.map((_, i) => i).filter((i) => i !== r.wolfSeat);

Deno.test("start seats every player once, plus exactly one wolf", () => {
  const r = begun(4);
  eq(r.phase, "answer");
  eq(r.chapter, 0);
  eq(r.seats.length, 5);
  eq(r.seats.filter((s) => s.playerId === null).length, 1);
  eq(r.seats[r.wolfSeat].playerId, null);
  eq(new Set(r.seats.map((s) => s.playerId).filter(Boolean)).size, 4);
  eq(new Set(r.seats.map((s) => s.cast)).size, 5, "distinct disguises");
  eq(r.questions.length, 3);
  eq(r.questions[2], "prove you're human. go.");
  eq(r.deadline, 1_000 + T.warmupMs! + T.answerMs);
});

Deno.test("only the host starts, and not alone", () => {
  throwsStatus(() => start(room(3), false, 0, T), 403);
  throwsStatus(() => start(room(1), true, 0, T), 409);
});

Deno.test("each seat answers once; the last answer opens the discussion", () => {
  const r = begun(2);
  const [a, b] = humanSeats(r);
  eq(say(r, a, " cold  pizza ", 2_000, T), [{ kind: "answer", seat: a, text: "cold pizza" }] as Draft[]);
  throwsStatus(() => say(r, a, "again", 2_100, T), 409);
  say(r, b, "chips", 2_200, T);
  eq(r.phase, "answer", "still waiting on the wolf");
  const out = say(r, r.wolfSeat, "ramen", 2_300, T);
  eq(r.phase, "discuss");
  eq(out.at(-1)?.kind, "sys");
  eq(say(r, a, "ok who", 2_400, T)[0].kind, "chat");
});

Deno.test("an empty or unseated message is refused", () => {
  const r = begun(2);
  throwsStatus(() => say(r, humanSeats(r)[0], "   ", 0, T), 400);
  throwsStatus(() => say(r, -1, "hi", 0, T), 403);
});

Deno.test("timeouts walk the tale from chapter to chapter to the vote", () => {
  const r = begun(2);
  eq(tick(r, 1_000, T), null, "nothing due yet");
  tick(r, r.deadline!, T);
  eq(r.phase, "discuss");
  for (const ch of [1, 2]) {
    tick(r, r.deadline!, T);
    eq([r.phase, r.chapter], ["answer", ch]);
    tick(r, r.deadline!, T);
    eq(r.phase, "discuss");
  }
  tick(r, r.deadline!, T);
  eq(r.phase, "vote");
  tick(r, r.deadline!, T);
  eq(r.phase, "reveal");
  eq(r.result?.accused, null, "nobody voted");
  eq(r.result?.humansWin, false);
});

Deno.test("onward: the host moves at once, others need a majority of those here", () => {
  eq([majority(1), majority(2), majority(3), majority(4)], [1, 2, 2, 3]);
  const r = begun(3);
  tick(r, r.deadline!, T); // -> discuss
  const [p0, p1] = r.players;
  eq(proceed(r, "onward", p1.id, false, 3, 0, T), []);
  eq(r.phase, "discuss");
  proceed(r, "onward", p1.id, false, 3, 0, T); // asking twice doesn't count twice
  eq(r.onward.length, 1);
  proceed(r, "onward", p0.id, false, 3, 0, T);
  eq([r.phase, r.chapter], ["answer", 1]);
  tick(r, r.deadline!, T);
  proceed(r, "early", p0.id, true, 3, 0, T);
  eq(r.phase, "vote", "the host can name the wolf early");
});

Deno.test("in the last chapter, onward knocks on grandma's door", () => {
  const r = begun(2);
  for (let i = 0; i < 5; i++) tick(r, r.deadline!, T);
  eq([r.phase, r.chapter], ["discuss", 2]);
  proceed(r, "onward", r.players[0].id, true, 2, 0, T);
  eq(r.phase, "vote");
});

Deno.test("votes: the wolf needs strictly the most votes to be caught", () => {
  const r = begun(3);
  for (let i = 0; i < 6; i++) tick(r, r.deadline!, T);
  eq(r.phase, "vote");
  const [a, b, c] = humanSeats(r);
  throwsStatus(() => castVote(r, a, a, 0), 400);
  castVote(r, a, r.wolfSeat, 0);
  throwsStatus(() => castVote(r, a, b, 0), 409);
  castVote(r, b, r.wolfSeat, 0);
  castVote(r, c, a, 0);
  eq(r.phase, "vote", "the wolf hasn't voted");
  castVote(r, r.wolfSeat, c, 0);
  eq(r.phase, "reveal");
  eq(r.result?.accused, r.wolfSeat);
  eq(r.result?.humansWin, true);
});

Deno.test("votes: a tie lets the wolf slip away", () => {
  const r = begun(3);
  for (let i = 0; i < 6; i++) tick(r, r.deadline!, T);
  const [a, b, c] = humanSeats(r);
  castVote(r, a, r.wolfSeat, 0);
  castVote(r, b, r.wolfSeat, 0);
  castVote(r, c, a, 0);
  castVote(r, r.wolfSeat, a, 0);
  eq(r.result?.accused, null);
  eq(r.result?.humansWin, false);
});

Deno.test("again goes back to the cottage with a new game number", () => {
  const r = begun(3);
  for (let i = 0; i < 7; i++) tick(r, r.deadline!, T);
  eq(r.phase, "reveal");
  const gone = r.players[0].id;
  again(r, 0, (p) => p.id !== gone);
  eq([r.phase, r.game, r.seats.length, r.wolfSeat], ["lobby", 2, 0, -1]);
  eq(r.players.length, 2);
  assert(r.players.some((p) => p.id === r.hostId), "a remaining player leads the way");
});

Deno.test("views hide real names and the wolf until the reveal", () => {
  const r = begun(3);
  const me = r.players[1];
  const online = new Set(r.players.map((p) => p.id));
  const v = viewFor(r, me.id, online, [], 0);
  eq(v.you.seat, seatOf(r, me.id));
  eq(v.players, [], "no names mid-tale");
  const text = JSON.stringify(v);
  for (const p of r.players) assert(!text.includes(p.token), "tokens never leave the server");
  for (const p of r.players.filter((p) => p !== me)) assert(!text.includes(`"${p.name}"`), `${p.name} leaked`);
  assert(!("wolf" in v.seats[0]), "wolf flag hidden");
  for (let i = 0; i < 7; i++) tick(r, r.deadline!, T);
  const end = viewFor(r, me.id, online, [], 0);
  eq(end.seats.filter((s) => s.wolf).length, 1);
  eq(end.seats[r.wolfSeat].player, null);
});

Deno.test("tells compare the wolf with everyone else", () => {
  const r = begun(2);
  const [a, b] = humanSeats(r);
  const at = r.chapterStarts[0];
  const m = (seat: number, text: string, dt: number, kind: "answer" | "chat" = "answer") => ({
    id: String(dt),
    kind,
    seat,
    text,
    at: at + dt,
    chapter: 0,
  });
  const name = castOf(r, r.wolfSeat).name;
  const tells = computeTells(r, [
    m(a, "chips", 20_000),
    m(b, "cold pizza again", 30_000),
    m(r.wolfSeat, "a balanced salad for lunch", 4_000),
    m(a, `${name} that was fast`, 40_000, "chat"),
  ]);
  assert(tells[0].includes("4s") && tells[0].includes("25s"), tells[0]);
  assert(tells.some((t) => t.includes("1 time")), tells.join(" | "));
});

Deno.test("mentions match a seat's name as a word", () => {
  assert(mentions("@maya explain", "maya"));
  assert(mentions("ok MAYA?", "maya"));
  assert(!mentions("mayall", "maya"));
  assert(mentions("dev is sus", "Dev"));
  assert(!mentions("devops", "Dev"));
});

Deno.test("slugify and tidy", () => {
  eq(slugify("Grandma's House!"), "grandmas-house");
  eq(slugify("  --Café  Nuit-- "), "cafe-nuit");
  eq(tidy('"Dev: BRO I had tacos — like four"', "Dev"), "BRO I had tacos, like four");
  eq(tidy("maya (you): lol", "maya"), "lol");
});

Deno.test("start opens the warm-up: each player gets a private opener from the wolf", () => {
  const r = warming(3);
  eq([r.phase, r.chapter, r.deadline], ["warmup", -1, 1_000 + T.warmupMs]);
  eq(Object.keys(r.warmup).sort(), r.players.map((p) => p.id).sort());
  for (const lines of Object.values(r.warmup)) eq(lines.map((l) => l.from), ["wolf"]);
  throwsStatus(() => say(r, humanSeats(r)[0], "hi", 2_000, T), 409);
});

Deno.test("warm-up chat: one line at a time, five lines, and the last reply ends it for everyone", () => {
  const r = warming(2);
  const [a, b] = r.players.map((p) => p.id);
  warmSay(r, a, "  hey whats up ", 2_000);
  eq(r.warmup[a].at(-1)?.text, "hey whats up");
  throwsStatus(() => warmSay(r, a, "again", 2_100), 409); // the wolf hasn't answered
  throwsStatus(() => warmSay(r, "nobody", "hi", 0), 403);
  throwsStatus(() => warmSay(r, b, "   ", 0), 400);
  for (let i = 0; i < 5; i++) {
    if (i > 0) warmSay(r, a, `line ${i}`, 2_200 + i);
    eq(warmReply(r, a, "ha ok", 2_300 + i, T), [], "b is still chatting");
  }
  throwsStatus(() => warmSay(r, a, "one more", 3_000), 409);
  eq(r.phase, "warmup", "a is done but b isn't");
  warmSay(r, b, "hi", 3_100);
  throwsStatus(() => warmReady(r, b, 3_200, T), 409); // not enough to learn from yet
  eq(r.ready, []);
});

Deno.test("warm-up ends early once everyone is ready, and on its candle", () => {
  const r = warming(2);
  const [a, b] = r.players.map((p) => p.id);
  for (const id of [a, b]) {
    for (let i = 0; i < 3; i++) {
      warmSay(r, id, `msg ${i}`, 2_000);
      warmReply(r, id, "ok", 2_000, T);
    }
  }
  eq(warmReady(r, a, 3_000, T), []);
  eq(r.phase, "warmup");
  const out = warmReady(r, b, 3_100, T);
  eq([r.phase, r.chapter], ["answer", 0]);
  eq(out.at(-1)?.kind, "chap");
  eq(warmSamples(r).length, 6);

  const late = warming(2);
  eq(tick(late, 1_000, T), null);
  tick(late, late.deadline!, T);
  eq([late.phase, late.chapter], ["answer", 0], "the candle moves everyone on");
});

Deno.test("a warm-up chat is private to its player", () => {
  const r = warming(2);
  const [a, b] = r.players;
  warmSay(r, a.id, "secret sauce", 2_000);
  const online = new Set([a.id, b.id]);
  const mine = viewFor(r, a.id, online, [], 0);
  const theirs = viewFor(r, b.id, online, [], 0);
  eq(mine.warm?.lines.map((l) => l.text).includes("secret sauce"), true);
  assert(!JSON.stringify(theirs).includes("secret sauce"), "b can see a's chat");
  tick(r, r.deadline!, T);
  eq(viewFor(r, a.id, online, [], 0).warm, null, "no chat after the warm-up");
});

Deno.test("style: measured from messages, described, and applied to scripted lines", () => {
  eq(profile([]), null);
  const lazy = profile(["lol idk man", "nah same", "tbh no clue lol"])!;
  assert(lazy.lowercase === 1 && lazy.bare === 1 && lazy.avgWords <= 3.5);
  eq(lazy.slang.slice(0, 2), ["lol", "idk"]);
  assert(describe(lazy).some((d) => d.includes("almost never capitalizes")));
  eq(
    restyle(lazy, "I had oatmeal for breakfast and a delicious turkey sandwich for lunch!"),
    "i had oatmeal for breakfast",
  );
  const loud = profile(["Hey!! That is SO good!", "Wow! Amazing!"])!;
  eq(restyle(loud, "that was fine."), "that was fine!");
  const fun = profile(["pizza 😂", "no way 😂 lol"])!;
  eq(restyle(fun, "fair enough"), "fair enough 😂");
  eq(restyle(null, "Unchanged."), "Unchanged.");
  eq(restyle(profile(["one"]), "Unchanged."), "Unchanged.", "one sample isn't a style");
});

Deno.test("the wolf starts on one player's style and drifts toward the group's, chapter by chapter", () => {
  const r = warming(3);
  const [a, b] = r.players.map((p) => p.id);
  r.warmup[a].push({ from: "you", text: "lol idk man", at: 0 });
  r.warmup[b].push({ from: "you", text: "I think that sounds great, thank you.", at: 0 });
  const first = anchorLines(r);
  assert(first.length === 1 && (first[0] === "lol idk man" || first[0].startsWith("I think")), "anchors on one player");
  eq(anchorLines(r), first, "the anchor holds for the whole tale");
  eq(driftWeight(r, 10), 0, "no drift during the warm-up");
  tick(r, r.deadline!, T);
  eq(driftWeight(r, 1), 0, "nothing to drift toward yet");
  const ws = [0, 1, 2].map((ch) => {
    r.chapter = ch;
    return driftWeight(r, 5);
  });
  assert(ws[0] > 0 && ws[0] < ws[1] && ws[1] < ws[2], `drift grows: ${ws}`);
  r.phase = "vote";
  assert(driftWeight(r, 5) > ws[2]);
});

Deno.test("careful styles get more reasoning than casual ones", () => {
  const casual = profile(["lol idk", "nah same", "tbh no clue"]);
  const careful = profile([
    "I think that sounds like a really good plan for the weekend.",
    "Honestly, I would rather stay in and finish my reading.",
  ]);
  eq(effortFor(null, "low"), "low");
  eq(effortFor(casual, "low"), "low");
  eq(effortFor(careful, "low"), "high");
  eq(effortFor(profile(["Yeah sure.", "ok cool", "Not really."]), "low"), "medium");
});

const answerMsg = (seat: number, at: number, chapter = 0): Msg => ({
  id: `id${at}`,
  kind: "answer",
  seat,
  text: `answer from ${seat}`,
  at,
  chapter,
});

Deno.test("answers stay hidden until the chapter closes; your own shows at once", () => {
  const r = begun(3);
  const [a, b, c] = humanSeats(r);
  const batch = [answerMsg(b, 100), answerMsg(a, 200), answerMsg(c, 300)];
  const sent = new Set<string>();
  const first = deliverable(r, a, batch, sent);
  eq(first.msgs.map((m) => m.seat), [a], "a sees only their own while it's open");
  eq(first.upTo, undefined, "the cursor can't pass b's held answer");
  eq(deliverable(r, a, batch, sent).msgs, [], "nothing is delivered twice");

  r.phase = "discuss";
  const rest = deliverable(r, a, batch, sent);
  eq(rest.msgs.map((m) => m.seat).sort(), [b, c].sort(), "the rest arrive once it closes, a's not repeated");
  eq(rest.upTo, "id300");
  for (const m of rest.msgs) eq(m.at, 0, "no timestamp");
  assert(rest.msgs.every((m) => !/^id\d/.test(m.id)), "no time-ordered id");
});

Deno.test("revealed answers aren't in submission order, and every viewer sees the same order", () => {
  let differs = false;
  for (let game = 1; game <= 20 && !differs; game++) {
    const r = begun(6);
    r.game = game;
    r.phase = "discuss";
    const seats = humanSeats(r);
    const batch = seats.map((s, i) => answerMsg(s, 100 + i));
    const viewer = r.seats.length; // not any seat: sees everyone's
    const order = deliverable(r, viewer, batch, new Set()).msgs.map((m) => m.seat);
    eq(order, deliverable(r, viewer, batch, new Set()).msgs.map((m) => m.seat), "stable");
    eq([...order].sort(), [...seats].sort());
    if (JSON.stringify(order) !== JSON.stringify(seats)) differs = true;
  }
  assert(differs, "never reordered");
});

Deno.test("while answering, views hide who has answered and who is typing", () => {
  const r = begun(3);
  const [a, b] = r.players;
  const [sa, sb] = [seatOf(r, a.id), seatOf(r, b.id)];
  say(r, sb, "hello", 2_000, T);
  const online = new Set(r.players.map((p) => p.id));
  const v = viewFor(r, a.id, online, [sb, r.wolfSeat], 0);
  assert(v.seats.every((s) => !s.typing), "no typing during answers");
  assert(v.seats.every((s) => !s.answered), "b's answer isn't flagged");
  eq(v.counts.answered, 1, "the count is still shown");
  say(r, sa, "mine", 2_100, T);
  eq(viewFor(r, a.id, online, [], 0).seats[sa].answered, true, "you can see your own");
  say(r, humanSeats(r).find((x) => x !== sa && x !== sb)!, "third", 2_200, T);
  say(r, r.wolfSeat, "wolf", 2_300, T);
  eq(r.phase, "discuss");
  assert(viewFor(r, a.id, online, [sb], 0).seats[sb].typing, "typing is back once the answers are out");
});
