import {
  again,
  castOf,
  castVote,
  computeTells,
  type Draft,
  majority,
  mentions,
  newPlayer,
  newRoom,
  proceed,
  type Room,
  say,
  seatOf,
  start,
  tick,
  viewFor,
} from "../server/game.ts";
import { slugify } from "../server/store.ts";
import { tidy } from "../server/wolf.ts";

const T = { answerMs: 60_000, discussMs: 75_000, voteMs: 45_000 };

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

function begun(players = 3): Room {
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
  eq(r.deadline, 1_000 + T.answerMs);
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
