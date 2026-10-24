// Rooms, messages, presence and typing in Deno KV, all under NS.
//
// Key layout (everything expires, so finished tales don't pile up in global-kv):
//   [...NS, "room", server]                  Room state
//   [...NS, "pulse", server]                 rewritten on every change; SSE streams watch it
//   [...NS, "msg", server, game, id]         the chat log of one tale
//   [...NS, "presence", server, playerId]    last heartbeat of a connected player
//   [...NS, "typing", server, seat]          "is writing…"
//   [...NS, "lease", server]                 which server process plays the wolf
//   [...NS, "index", server]                 the front page's list of servers

import { NS } from "./kv.ts";
import {
  again,
  castVote,
  cleanText,
  computeTells,
  type Draft,
  GameError,
  hostOf,
  MAX_NAME,
  MAX_PLAYERS,
  type Msg,
  newPlayer,
  newRoom,
  type Player,
  proceed,
  type Room,
  say,
  seatOf,
  start,
  sys,
  tick,
  type Timing,
} from "./game.ts";

const TTL = 6 * 60 * 60_000;
const ONLINE_MS = 45_000;
const TYPING_MS = 6_000;
const LISTED_MS = 2 * 60 * 60_000;

export const keys = {
  room: (s: string) => [...NS, "room", s],
  pulse: (s: string) => [...NS, "pulse", s],
  msgs: (s: string, game: number) => [...NS, "msg", s, game],
  presence: (s: string) => [...NS, "presence", s],
  typing: (s: string) => [...NS, "typing", s],
  lease: (s: string) => [...NS, "lease", s],
  index: () => [...NS, "index"],
};

export interface ServerInfo {
  slug: string;
  phase: Room["phase"];
  players: number;
  updatedAt: number;
}

type Mutation = { room: Room; drafts: Draft[] } | null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "Grandma's House!" -> "grandmas-house" */
export function slugify(raw: unknown): string {
  return String(raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

// Message ids sort by time, then by order within one commit.
let seq = 0;
function nextId(now: number): string {
  seq = (seq + 1) % 1_679_616;
  return now.toString(36).padStart(9, "0") + seq.toString(36).padStart(4, "0") + crypto.randomUUID().slice(0, 4);
}

export class Store {
  constructor(readonly kv: Deno.Kv, readonly timing: Timing, readonly ai: Room["ai"]) {}

  async room(slug: string): Promise<Room | null> {
    return (await this.kv.get<Room>(keys.room(slug))).value;
  }

  /**
   * Read-modify-write a room with an optimistic check, retrying on conflict.
   * fn gets a private copy and returns the new room plus messages to append,
   * or null to change nothing.
   */
  async mutate(
    slug: string,
    fn: (room: Room | null, now: number) => Mutation | Promise<Mutation>,
  ): Promise<{ room: Room | null; msgs: Msg[] }> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const entry = await this.kv.get<Room>(keys.room(slug));
      const now = Date.now();
      const res = await fn(entry.value ? structuredClone(entry.value) : null, now);
      if (!res) return { room: entry.value, msgs: [] };
      const { room, drafts } = res;
      if (room.phase === "reveal" && room.result && room.result.tells.length === 0) {
        room.result.tells = computeTells(room, await this.messages(slug, room.game));
      }
      room.updatedAt = now;
      const msgs: Msg[] = drafts.map((d) => ({ ...d, id: nextId(now), at: now, chapter: room.chapter }));
      const info: ServerInfo = { slug, phase: room.phase, players: room.players.length, updatedAt: now };
      const op = this.kv.atomic()
        .check(entry)
        .set(keys.room(slug), room, { expireIn: TTL })
        .set(keys.pulse(slug), crypto.randomUUID(), { expireIn: TTL })
        .set([...keys.index(), slug], info, { expireIn: TTL });
      for (const m of msgs) op.set([...keys.msgs(slug, room.game), m.id], m, { expireIn: TTL });
      if ((await op.commit()).ok) return { room, msgs };
      await sleep(5 + Math.random() * 25 * (attempt + 1));
    }
    throw new GameError("The forest is crowded right now. Try that again.", 503);
  }

  /** One tale's messages, oldest first; only those after `after` when given. */
  async messages(slug: string, game: number, after?: string): Promise<Msg[]> {
    const prefix = keys.msgs(slug, game);
    const out: Msg[] = [];
    const sel = after ? { prefix, start: [...prefix, after] } : { prefix };
    for await (const e of this.kv.list<Msg>(sel)) if (e.value.id !== after) out.push(e.value);
    return out;
  }

  watch(slug: string): ReadableStream<unknown> {
    return this.kv.watch([keys.pulse(slug)]);
  }

  /** Heartbeat. Only pulses when someone arrives, so lobbies see them appear. */
  async touch(slug: string, playerId: string): Promise<void> {
    const k = [...keys.presence(slug), playerId];
    const was = await this.kv.get<number>(k);
    const now = Date.now();
    const op = this.kv.atomic().set(k, now, { expireIn: ONLINE_MS });
    if (!was.value || now - was.value > ONLINE_MS) op.set(keys.pulse(slug), crypto.randomUUID(), { expireIn: TTL });
    await op.commit();
  }

  async online(slug: string): Promise<Set<string>> {
    const now = Date.now();
    const ids = new Set<string>();
    for await (const e of this.kv.list<number>({ prefix: keys.presence(slug) })) {
      if (now - e.value < ONLINE_MS) ids.add(String(e.key.at(-1)));
    }
    return ids;
  }

  async setTyping(slug: string, seat: number): Promise<void> {
    await this.kv.atomic()
      .set([...keys.typing(slug), seat], Date.now(), { expireIn: TYPING_MS })
      .set(keys.pulse(slug), crypto.randomUUID(), { expireIn: TTL })
      .commit();
  }

  async typingSeats(slug: string): Promise<number[]> {
    const now = Date.now();
    const seats: number[] = [];
    for await (const e of this.kv.list<number>({ prefix: keys.typing(slug) })) {
      if (now - e.value < TYPING_MS) seats.push(Number(e.key.at(-1)));
    }
    return seats;
  }

  async servers(): Promise<ServerInfo[]> {
    const now = Date.now();
    const out: ServerInfo[] = [];
    for await (const e of this.kv.list<ServerInfo>({ prefix: keys.index() })) {
      if (e.value.players > 0 && now - e.value.updatedAt < LISTED_MS) out.push(e.value);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
  }

  // ---- player requests ------------------------------------------------------------

  /** Join (or rejoin) a server by name. Creates the server if nobody's there yet. */
  async join(
    rawServer: unknown,
    rawName: unknown,
    token?: unknown,
  ): Promise<{ slug: string; token: string; name: string }> {
    const slug = slugify(rawServer);
    if (slug.length < 2) throw new GameError("Server names need at least two letters or numbers.");
    const name = cleanText(rawName, MAX_NAME);
    if (!name) throw new GameError("Tell us your name first.");
    const online = await this.online(slug);
    let me = null as Player | null;

    await this.mutate(slug, (room, now) => {
      if (!room) {
        me = newPlayer(name, now);
        return { room: newRoom(slug, me, now, this.ai), drafts: [sys(`${name} found the cottage.`)] };
      }
      const taken = (p: Player) => p.name.toLowerCase() === name.toLowerCase();
      const mine = typeof token === "string" ? room.players.find((p) => p.token === token) : undefined;
      if (mine) {
        me = mine;
        if (room.phase !== "lobby" || mine.name === name) return null;
        if (room.players.some((p) => p !== mine && taken(p))) {
          throw new GameError("Someone by that name is already at the cottage. Pick another name.", 409);
        }
        const old = mine.name;
        mine.name = name;
        return { room, drafts: [sys(`${old} will go by ${name}.`)] };
      }
      const same = room.players.find(taken);
      if (same) {
        if (online.has(same.id)) {
          throw new GameError("Someone by that name is already at the cottage. Pick another name.", 409);
        }
        me = same; // a returning player (new browser, cleared storage) takes their place back
        return null;
      }
      if (room.phase !== "lobby") {
        throw new GameError(
          "A tale is already being told on this server. Wait for it to end, or pick another server.",
          409,
        );
      }
      room.players = room.players.filter((p) => online.has(p.id));
      if (room.players.length >= MAX_PLAYERS) {
        throw new GameError(`This cottage is full (${MAX_PLAYERS} friends at most).`, 409);
      }
      me = newPlayer(name, now);
      room.players.push(me);
      if (!room.players.some((p) => p.id === room.hostId)) room.hostId = room.players[0].id;
      return { room, drafts: [sys(`${name} found the cottage.`)] };
    });

    await this.touch(slug, me!.id);
    return { slug, token: me!.token, name: me!.name };
  }

  /** Everything a seated player can do, by `type`. */
  async act(slug: string, token: unknown, body: Record<string, unknown>): Promise<void> {
    const type = String(body.type ?? "");
    const room = await this.room(slug);
    const player = room?.players.find((p) => p.token === token);
    if (!room || !player) throw new GameError("You aren't part of this tale. Join from the front page.", 401);

    if (type === "typing") {
      const seat = seatOf(room, player.id);
      if (seat >= 0 && (room.phase === "answer" || room.phase === "discuss")) await this.setTyping(slug, seat);
      return;
    }
    if (type === "tick") return void await this.tick(slug);
    if (type === "leave") return await this.leave(slug, player.id);

    const online = await this.online(slug);
    online.add(player.id);
    await this.mutate(slug, (room, now) => {
      const me = room?.players.find((p) => p.id === player.id);
      if (!room || !me) throw new GameError("You aren't part of this tale. Join from the front page.", 401);
      const seat = seatOf(room, me.id);
      const isHost = hostOf(room, online) === me.id;
      const here = room.players.filter((p) => online.has(p.id)).length;
      const t = this.timing;
      let drafts: Draft[];
      switch (type) {
        case "start":
          room.players = room.players.filter((p) => online.has(p.id));
          room.ai = this.ai;
          drafts = start(room, isHost, now, t);
          break;
        case "say":
          drafts = say(room, seat, body.text, now, t);
          break;
        case "onward":
        case "early":
          drafts = proceed(room, type, me.id, isHost, here, now, t);
          break;
        case "vote":
          drafts = castVote(room, seat, Number(body.target), now);
          break;
        case "again":
          drafts = again(room, now, (p) => online.has(p.id));
          break;
        default:
          throw new GameError(`Unknown action "${type}".`);
      }
      return { room, drafts };
    });

    if (type === "say") {
      const seat = seatOf(room, player.id);
      if (seat >= 0) await this.kv.delete([...keys.typing(slug), seat]);
    }
  }

  async tick(slug: string): Promise<void> {
    await this.mutate(slug, (room, now) => {
      const drafts = room && tick(room, now, this.timing);
      return room && drafts ? { room, drafts } : null;
    });
  }

  /** Leaving the cottage before the tale starts frees your place; mid-tale your seat just goes quiet. */
  async leave(slug: string, playerId: string): Promise<void> {
    await this.mutate(slug, (room) => {
      const p = room?.players.find((x) => x.id === playerId);
      if (!room || !p || room.phase !== "lobby") return null;
      room.players = room.players.filter((x) => x.id !== playerId);
      if (room.hostId === playerId && room.players[0]) room.hostId = room.players[0].id;
      return { room, drafts: [sys(`${p.name} wandered back home.`)] };
    });
    await this.kv.delete([...keys.presence(slug), playerId]);
  }

  // ---- the wolf's moves (made by the wolf driver) -----------------------------------

  async wolfSay(
    slug: string,
    game: number,
    phase: "answer" | "discuss",
    chapter: number,
    text: string,
  ): Promise<boolean> {
    const { msgs } = await this.mutate(slug, (room, now) => {
      if (!room || room.game !== game || room.phase !== phase || room.chapter !== chapter) return null;
      if (phase === "answer" && room.answered.includes(room.wolfSeat)) return null;
      return { room, drafts: say(room, room.wolfSeat, text, now, this.timing) };
    });
    const room = await this.room(slug);
    if (room) await this.kv.delete([...keys.typing(slug), room.wolfSeat]);
    return msgs.length > 0;
  }

  async wolfVote(slug: string, game: number, target: number): Promise<void> {
    await this.mutate(slug, (room, now) => {
      if (!room || room.game !== game || room.phase !== "vote" || room.votes[room.wolfSeat] !== undefined) return null;
      return { room, drafts: castVote(room, room.wolfSeat, target, now) };
    });
  }
}
