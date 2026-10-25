// The rules of Big Bad Bot as pure functions on a Room. Nothing here touches KV
// or the network, so the whole tale can be unit tested.
//
// A tale: lobby -> 3 chapters of (answer -> discuss) -> vote -> reveal.
// Every player hides behind a storybook seat; one extra seat is the wolf.

import { CAST, castById, type CastMember, CHAPTERS, LAST_QUESTION, QUESTION_POOL } from "./cast.ts";

export type Phase = "lobby" | "answer" | "discuss" | "vote" | "reveal";
export type MsgKind = "chat" | "answer" | "sys" | "chap";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = CAST.length - 1;
export const MAX_MESSAGE = 280;
export const MAX_NAME = 20;

export interface Player {
  id: string;
  name: string;
  token: string;
  joinedAt: number;
}

/** A storybook disguise. playerId is null for the wolf's seat. */
export interface Seat {
  cast: string;
  playerId: string | null;
}

export interface Result {
  wolfSeat: number;
  /** Seat with strictly the most votes; null on a tie or when nobody voted. */
  accused: number | null;
  humansWin: boolean;
  votes: [from: number, to: number][];
  tells: string[];
}

export interface Room {
  slug: string;
  /** Bumped on every "read it again", so each tale has its own message log. */
  game: number;
  phase: Phase;
  chapter: number;
  questions: string[];
  chapterStarts: number[];
  phaseStartedAt: number;
  deadline: number | null;
  players: Player[];
  hostId: string;
  seats: Seat[];
  wolfSeat: number;
  /** Seats that answered this chapter's question (the wolf included). */
  answered: number[];
  /** Player ids asking to move on / to name the wolf early. */
  onward: string[];
  early: string[];
  /** voter seat -> accused seat */
  votes: Record<number, number>;
  result: Result | null;
  /** Why Claude couldn't play the wolf's last move. Cleared when a move goes through. */
  wolfError: { text: string; at: number } | null;
  createdAt: number;
  updatedAt: number;
}

export interface Draft {
  kind: MsgKind;
  text: string;
  seat?: number;
  label?: string;
}

export interface Msg extends Draft {
  id: string;
  at: number;
  chapter: number;
}

export interface Timing {
  answerMs: number;
  discussMs: number;
  voteMs: number;
}

export class GameError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const sys = (text: string): Draft => ({ kind: "sys", text });
const chap = (label: string, text: string): Draft => ({ kind: "chap", label, text });

export function newPlayer(name: string, now: number): Player {
  return { id: crypto.randomUUID(), name, token: crypto.randomUUID(), joinedAt: now };
}

export function newRoom(slug: string, host: Player, now: number): Room {
  return {
    slug,
    game: 1,
    phase: "lobby",
    chapter: -1,
    questions: [],
    chapterStarts: [],
    phaseStartedAt: now,
    deadline: null,
    players: [host],
    hostId: host.id,
    seats: [],
    wolfSeat: -1,
    answered: [],
    onward: [],
    early: [],
    votes: {},
    result: null,
    wolfError: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function cleanText(raw: unknown, max = MAX_MESSAGE): string {
  return String(raw ?? "")
    // deno-lint-ignore no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export const seatOf = (room: Room, playerId: string) => room.seats.findIndex((s) => s.playerId === playerId);
export const castOf = (room: Room, seat: number): CastMember => castById(room.seats[seat].cast);
export const majority = (n: number) => Math.floor(Math.max(n, 1) / 2) + 1;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when text names this seat, e.g. "@maya", "maya?", "MAYA is sus". */
export function mentions(text: string, name: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])@?${escapeRe(name)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** The host leads the way. If they've wandered off, the earliest player still here does. */
export function hostOf(room: Room, online: Set<string>): string {
  if (online.has(room.hostId)) return room.hostId;
  return room.players.find((p) => online.has(p.id))?.id ?? room.hostId;
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- phase transitions ----------------------------------------------------------

function beginChapter(room: Room, n: number, now: number, t: Timing): Draft[] {
  Object.assign(room, {
    phase: "answer",
    chapter: n,
    answered: [],
    onward: [],
    early: [],
    phaseStartedAt: now,
    deadline: now + t.answerMs,
  });
  room.chapterStarts[n] = now;
  return [chap(CHAPTERS[n], room.questions[n])];
}

function beginDiscuss(room: Room, now: number, t: Timing, everyoneAnswered: boolean): Draft[] {
  Object.assign(room, { phase: "discuss", onward: [], early: [], phaseStartedAt: now, deadline: now + t.discussMs });
  return [
    sys(
      everyoneAnswered ? "every answer is in. question anyone who seems off." : "the candle burns down. talk it over.",
    ),
  ];
}

function beginVote(room: Room, now: number, t: Timing): Draft[] {
  Object.assign(room, {
    phase: "vote",
    onward: [],
    early: [],
    votes: {},
    phaseStartedAt: now,
    deadline: now + t.voteMs,
  });
  return [chap("The Last Chapter", "what big eyes you have… so who is the wolf?")];
}

function endVote(room: Room, now: number): Draft[] {
  const votes = Object.entries(room.votes).map(([from, to]) => [Number(from), to] as [number, number]);
  const tally = new Map<number, number>();
  for (const [, to] of votes) tally.set(to, (tally.get(to) ?? 0) + 1);
  let accused: number | null = null;
  let best = 0;
  for (const [seat, n] of tally) {
    if (n > best) [best, accused] = [n, seat];
    else if (n === best) accused = null;
  }
  Object.assign(room, { phase: "reveal", phaseStartedAt: now, deadline: null });
  room.result = { wolfSeat: room.wolfSeat, accused, humansWin: accused === room.wolfSeat, votes, tells: [] };
  return [sys("the covers are pulled back…")];
}

// ---- player actions -------------------------------------------------------------

export function start(room: Room, isHost: boolean, now: number, t: Timing, rng = Math.random): Draft[] {
  if (room.phase !== "lobby") throw new GameError("The tale has already begun.", 409);
  if (!isHost) throw new GameError("Only the host can lead the way into the woods.", 403);
  if (room.players.length < MIN_PLAYERS) {
    throw new GameError(`At least ${MIN_PLAYERS} friends are needed before the tale can begin.`, 409);
  }
  const cast = shuffle(CAST, rng).slice(0, room.players.length + 1);
  const humans = shuffle(room.players.map((p) => p.id), rng);
  room.wolfSeat = Math.floor(rng() * cast.length);
  room.seats = cast.map((c, i) => ({ cast: c.id, playerId: i === room.wolfSeat ? null : humans.pop()! }));
  room.questions = [...shuffle(QUESTION_POOL, rng).slice(0, CHAPTERS.length - 1), LAST_QUESTION];
  room.chapterStarts = [];
  room.votes = {};
  room.result = null;
  room.wolfError = null;
  return [
    sys("the friends gather at the cottage door."),
    sys("somewhere ahead, the wolf is already typing in someone else's voice."),
    ...beginChapter(room, 0, now, t),
  ];
}

/** A message from a seat: the chapter answer while answering, plain chat while discussing. */
export function say(room: Room, seat: number, raw: unknown, now: number, t: Timing): Draft[] {
  if (seat < 0) throw new GameError("You aren't seated in this tale.", 403);
  const text = cleanText(raw);
  if (!text) throw new GameError("Write something first.");
  if (room.phase === "answer") {
    if (room.answered.includes(seat)) throw new GameError("You've answered. Wait for the others.", 409);
    room.answered.push(seat);
    const out: Draft[] = [{ kind: "answer", seat, text }];
    if (room.answered.length >= room.seats.length) out.push(...beginDiscuss(room, now, t, true));
    return out;
  }
  if (room.phase === "discuss") return [{ kind: "chat", seat, text }];
  throw new GameError("Hush. This isn't the time to talk.", 409);
}

/**
 * "Onward" moves to the next chapter; "Name the wolf early" (and, in the last
 * chapter, "Knock on grandma's door") moves to the vote. The host moves the
 * tale at once; anyone else adds a request, and a majority of the players who
 * are here moves it.
 */
export function proceed(
  room: Room,
  kind: "onward" | "early",
  playerId: string,
  isHost: boolean,
  playersHere: number,
  now: number,
  t: Timing,
): Draft[] {
  if (room.phase !== "discuss") throw new GameError("Wait until every answer is in.", 409);
  const toVote = kind === "early" || room.chapter >= CHAPTERS.length - 1;
  const asks = toVote ? room.early : room.onward;
  if (!asks.includes(playerId)) asks.push(playerId);
  if (!isHost && asks.length < majority(playersHere)) return [];
  return toVote ? beginVote(room, now, t) : beginChapter(room, room.chapter + 1, now, t);
}

export function castVote(room: Room, seat: number, target: number, now: number): Draft[] {
  if (room.phase !== "vote") throw new GameError("It isn't time to name the wolf yet.", 409);
  if (seat < 0) throw new GameError("You aren't seated in this tale.", 403);
  if (!Number.isInteger(target) || target < 0 || target >= room.seats.length) {
    throw new GameError("Pick someone from the cast.");
  }
  if (target === seat) throw new GameError("You can't name yourself.");
  if (room.votes[seat] !== undefined) throw new GameError("Your vote is already cast.", 409);
  room.votes[seat] = target;
  return Object.keys(room.votes).length >= room.seats.length ? endVote(room, now) : [];
}

/** Moves past a phase whose candle has burned out. Null when nothing is due. */
export function tick(room: Room, now: number, t: Timing): Draft[] | null {
  if (room.deadline === null || now < room.deadline) return null;
  switch (room.phase) {
    case "answer":
      return beginDiscuss(room, now, t, false);
    case "discuss":
      return room.chapter >= CHAPTERS.length - 1
        ? beginVote(room, now, t)
        : beginChapter(room, room.chapter + 1, now, t);
    case "vote":
      return endVote(room, now);
    default:
      room.deadline = null;
      return [];
  }
}

/** "Read it again": back to the cottage with whoever is still around, and a new wolf. */
export function again(room: Room, now: number, keep: (p: Player) => boolean): Draft[] {
  if (room.phase !== "reveal") throw new GameError("The tale isn't over yet.", 409);
  Object.assign(room, {
    game: room.game + 1,
    phase: "lobby",
    chapter: -1,
    questions: [],
    chapterStarts: [],
    phaseStartedAt: now,
    deadline: null,
    seats: [],
    wolfSeat: -1,
    answered: [],
    onward: [],
    early: [],
    votes: {},
    result: null,
    wolfError: null,
  });
  room.players = room.players.filter(keep);
  if (!room.players.some((p) => p.id === room.hostId) && room.players[0]) room.hostId = room.players[0].id;
  return [sys("the book closes, and opens again to the first page.")];
}

// ---- the reveal -----------------------------------------------------------------

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const one = (n: number) => (Math.round(n * 10) / 10).toString();

/** What gave the wolf away, measured from this tale's messages. */
export function computeTells(room: Room, msgs: Msg[]): string[] {
  const wolf = room.wolfSeat;
  const name = castOf(room, wolf).name;
  const said = msgs.filter((m) => m.seat !== undefined && (m.kind === "chat" || m.kind === "answer"));
  const wolfSaid = said.filter((m) => m.seat === wolf);
  const humanSaid = said.filter((m) => m.seat !== wolf);
  const tells: string[] = [];

  const latency = (ms: Msg[]) =>
    ms.filter((m) => m.kind === "answer").map((m) => (m.at - (room.chapterStarts[m.chapter] ?? m.at)) / 1000);
  const wolfLat = latency(wolfSaid);
  const humanLat = latency(humanSaid);
  if (wolfLat.length && humanLat.length) {
    tells.push(
      `It took ${one(avg(wolfLat))}s to answer each question; the rest of you averaged ${one(avg(humanLat))}s.`,
    );
  }
  if (wolfSaid.length) {
    const w = avg(wolfSaid.map((m) => words(m.text)));
    const h = avg(humanSaid.map((m) => words(m.text)));
    tells.push(
      `Its ${wolfSaid.length} message${wolfSaid.length === 1 ? "" : "s"} averaged ${one(w)} words; yours averaged ${
        one(h)
      }.`,
    );
  } else {
    tells.push("It never said a word. Silence is a tell too.");
  }
  const calledOut = humanSaid.filter((m) => m.kind === "chat" && mentions(m.text, name)).length;
  tells.push(
    calledOut
      ? `You called ${name} out by name ${calledOut} time${calledOut === 1 ? "" : "s"}.`
      : `Nobody called ${name} out by name the whole tale.`,
  );
  const wolfVote = room.votes[wolf];
  if (wolfVote !== undefined) tells.push(`It voted to unmask ${castOf(room, wolfVote).name} to blend in.`);
  return tells;
}

// ---- what one player is allowed to see -------------------------------------------

/**
 * A player's view of the room. Real names stay hidden behind the cast until the
 * reveal; the only seat a player learns is their own.
 */
export function viewFor(room: Room, playerId: string, online: Set<string>, typing: number[], now: number) {
  const me = room.players.find((p) => p.id === playerId)!;
  const seat = seatOf(room, playerId);
  const host = hostOf(room, online);
  const reveal = room.phase === "reveal";
  const here = room.players.filter((p) => online.has(p.id)).length;
  return {
    now,
    server: room.slug,
    game: room.game,
    phase: room.phase,
    chapter: room.chapter,
    question: room.questions[room.chapter] ?? null,
    deadline: room.deadline,
    wolfError: room.wolfError?.text ?? null,
    you: {
      name: me.name,
      seat,
      host: host === playerId,
      answered: room.answered.includes(seat),
      onward: room.onward.includes(playerId),
      early: room.early.includes(playerId),
      vote: seat >= 0 ? room.votes[seat] ?? null : null,
    },
    hostName: room.phase === "lobby" ? room.players.find((p) => p.id === host)?.name ?? null : null,
    players: room.phase === "lobby"
      ? room.players.map((p) => ({ name: p.name, online: online.has(p.id), host: p.id === host }))
      : [],
    seats: room.seats.map((s, i) => {
      const c = castById(s.cast);
      return {
        seat: i,
        name: c.name,
        role: c.role,
        color: c.color,
        voice: c.voice,
        answered: room.answered.includes(i),
        typing: typing.includes(i),
        ...(reveal
          ? {
            wolf: i === room.wolfSeat,
            player: s.playerId ? room.players.find((p) => p.id === s.playerId)?.name ?? "someone who left" : null,
          }
          : {}),
      };
    }),
    counts: {
      players: room.players.length,
      here,
      need: majority(here),
      onward: room.onward.length,
      early: room.early.length,
      answered: room.answered.length,
      voted: Object.keys(room.votes).length,
    },
    result: reveal ? room.result : null,
  };
}

export type View = ReturnType<typeof viewFor>;
