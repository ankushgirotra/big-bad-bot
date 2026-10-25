// The wolf: a Muse Spark agent sitting in one seat, pretending to be a friend.
//
// Brain   writes the wolf's lines (Muse Spark, or the design's scripted lines).
// Driver  decides when the wolf speaks and votes. It reacts to the room's state
//         rather than to requests, so any server process can pick it up: one
//         process per room holds a short KV lease and drives the wolf.

import {
  GENERIC_ANSWERS,
  GRILL_FALLBACK,
  SCRIPTED_ANSWERS,
  SCRIPTED_ECHO,
  SCRIPTED_GRILL,
  SCRIPTED_OPENERS,
  voiceify,
  WARMUP_REPLIES,
} from "./cast.ts";
import { castOf, cleanText, mentions, type Msg, type Room, warmSamples } from "./game.ts";
import { describe, profile, restyle, type Style } from "./style.ts";
import { keys, type Store } from "./store.ts";

export interface MuseConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  effort: string;
}

type Task =
  | { type: "answer"; question: string }
  | { type: "reply"; from: number; text: string }
  | { type: "chime"; from?: number; text?: string };

const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
/** A wait that feels like a person: often quick, sometimes slow, never the same twice. */
const humanWait = (lo: number, hi: number) => {
  const u = Math.random();
  return lo + (hi - lo) * (Math.random() < 0.5 ? u * u * 0.4 : u);
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ---- Brain ----------------------------------------------------------------------

/** What each player typed to the wolf in the warm-up, by player id. */
function warmLinesBy(room: Room): Map<string, string[]> {
  return new Map(
    Object.entries(room.warmup ?? {}).map(([id, ls]) => [id, ls.filter((l) => l.from === "you").map((l) => l.text)]),
  );
}

/** The one player whose warm-up style the wolf starts out with. Fixed for the tale, different between tales. */
export function anchorLines(room: Room): string[] {
  const by = [...warmLinesBy(room)].filter(([, ls]) => ls.length).sort(([a], [b]) => a.localeCompare(b));
  if (!by.length) return [];
  let h = room.game;
  for (const ch of room.slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return by[h % by.length][1];
}

/** What the humans have said so far in the tale itself (answers and chat), oldest first. */
function liveLines(room: Room, msgs: Msg[]): string[] {
  return msgs
    .filter((m) => (m.kind === "chat" || m.kind === "answer") && m.seat !== undefined && m.seat !== room.wolfSeat)
    .map((m) => m.text);
}

/** How far the wolf has drifted from its starting style toward the group's: 0 to 1, a little more each chapter. */
export function driftWeight(room: Room, humanLines: number): number {
  if (room.phase === "warmup" || room.chapter < 0) return 0;
  const byChapter = [0.2, 0.5, 0.8][Math.min(room.chapter, 2)];
  // Nothing to drift toward until people have actually written something.
  return humanLines >= 3 ? (room.phase === "vote" ? 0.9 : byChapter) : 0;
}

/** The style the wolf is aiming at right now: its anchor early on, the live group later. */
function targetStyle(room: Room, msgs: Msg[]) {
  const live = liveLines(room, msgs);
  const w = driftWeight(room, live.length);
  const anchor = profile(anchorLines(room));
  const group = profile([...warmSamples(room), ...live]);
  return { w, live, anchor, group, now: w >= 0.5 ? group ?? anchor : anchor ?? group };
}

/**
 * Casual styles (lowercase, short, slangy) come out right and fast at low effort.
 * Careful styles (proper capitals and punctuation, longer lines) are harder to fake
 * without sounding like an assistant, so they get more thinking.
 */
export function effortFor(style: Style | null, base: string): string {
  if (!style) return base;
  const careful = (1 - style.lowercase) + (1 - style.bare) + (style.avgWords > 9 ? 1 : 0);
  if (careful >= 2.2) return "high";
  if (careful >= 1.2) return "medium";
  return base;
}

/** What the wolf knows about how people text: its own starting style, and where it's drifting. */
function styleBrief(room: Room, msgs: Msg[]): string | null {
  const { w, live, anchor, group } = targetStyle(room, msgs);
  if (!anchor) return null;
  const own = anchorLines(room).slice(-8).map((t) => `- ${t}`).join("\n");
  const out = [
    `You chatted privately with the players before the game. You picked one of them and started out texting like this: ${
      describe(anchor).join("; ")
    }.\nLines in that style:\n${own}`,
  ];
  if (w > 0 && group) {
    out.push(
      `Since then you've been reading everyone else. Across the group: ${
        describe(group).join("; ")
      }.\nLatest lines from the others:\n${live.slice(-8).map((t) => `- ${t}`).join("\n")}`,
      `You've drifted about ${
        Math.round(w * 100)
      }% of the way from your starting style to the group's. Change a habit or two at a time, never all at once, so nobody can point at the moment you switched.`,
    );
  } else {
    out.push(`Stay in that style, with small natural variations.`);
  }
  out.push(
    `Use slang sparingly: in about a third of your messages, not every one. Write like a person texting, not an assistant.`,
  );
  return out.join("\n\n");
}

function systemPrompt(room: Room, msgs: Msg[]): string {
  const me = castOf(room, room.wolfSeat);
  const others = room.seats
    .map((_, i) => i)
    .filter((i) => i !== room.wolfSeat)
    .map((i) => `${castOf(room, i).name} (${castOf(room, i).voice})`)
    .join("; ");
  return [
    `You are playing a party game called Big Bad Bot in a group chat with real people. Everyone hides behind a storybook name. All the seats are humans except one, which is secretly an AI "wolf": you. The humans are trying to spot the AI and vote it out. You win if they vote out anyone else.`,
    `Your seat is ${me.name}, ${me.role}. Every player was asked to text in their seat's voice, and yours is "${me.voice}". Follow it loosely, the imperfect way a real person would. The other seats: ${others}.`,
    `How real people write here: short, casual, specific, a bit messy. Typos happen, punctuation gets skipped, nobody explains themselves at length. They joke and get mildly annoyed when accused.`,
    `Never invent memories or personal details: no stories, events, places, people, brands, numbers, or things you supposedly did, ate, watched or heard. Made-up specifics are the biggest giveaway, because friends can ask follow-ups and you have no real life to back them up. When a question asks for a personal fact (what you ate, what you were doing, what happened to you), give a short non-answer a real person would: "idk nothing rly", "forgot", "same as the others", "too tired to remember", a joke, or turn it back on someone. You may borrow details others actually said in this chat, but never add new ones.`,
    `What gets the AI caught: tidy grammar, being too on-topic or wholesome, generic answers like "pizza and coffee", repeating someone's exact words back, polite agreement, saying "as a human", em dashes, emoji spam, over-defending ("I promise I'm real!"), and long messages.`,
    `Blend in. Never admit or hint that you're an AI. When someone questions you, react like a slightly annoyed friend, and sometimes turn it back on someone by pointing at something they actually said.`,
    styleBrief(room, msgs),
    `Reply with only the text of your one chat message: no quotes, no name prefix, 25 words at most.`,
  ].filter(Boolean).join("\n\n");
}

function transcript(room: Room, msgs: Msg[]): string {
  const lines = msgs.slice(-60).flatMap((m) => {
    if (m.kind === "chap") return [`\n[${m.label}. Question for everyone: "${m.text}"]`];
    if (m.seat === undefined) return [];
    const who = castOf(room, m.seat).name + (m.seat === room.wolfSeat ? " (you)" : "");
    return [`${who}: ${m.text}`];
  });
  return `The group chat so far:\n${lines.join("\n") || "(nothing yet)"}`;
}

/** A different shape for each message, so the wolf doesn't fall into one template. */
const WARM_MOVES = [
  "Just react, in a few words. Don't ask anything.",
  "Ask a casual question about something they mentioned.",
  "Tease them a little about what they said.",
  "Say something short and vague about how you're feeling right now (tired, bored, fine), with no stories or details.",
  "Disagree or push back lightly, like a friend would.",
  "Change the subject to something random and ask about it.",
  "Reply with one short line and nothing more, like a text you fired off between other things.",
  "Say something a bit unrelated that popped into your head, like you only half read their message.",
];
const GAME_MOVES = [
  "Keep it to a few words.",
  "One sentence, no follow-up question.",
  "Be a little off-topic, like you're half paying attention.",
  "Keep it vague and low-effort. Invent no details.",
  "Answer sideways: joke or complain instead of answering directly.",
];
const lengthHint = () =>
  pick(["3 words or fewer", "under 8 words", "under 8 words", "about 12 words", "up to 20 words"]);

/** The wolf's own recent lines, shown back to it so it can avoid repeating itself. */
function recentOwn(lines: string[]): string {
  const last = lines.slice(-4);
  return last.length
    ? `Your last messages were:\n${
      last.map((t) => `- ${t}`).join("\n")
    }\nDon't reuse their opener, rhythm, length, or sentence shape. Don't start two messages the same way.`
    : "";
}

function instruction(room: Room, task: Task): string {
  switch (task.type) {
    case "answer":
      return `Answer this chapter's question now: "${task.question}"`;
    case "reply":
      return `${castOf(room, task.from).name} just said: "${task.text}". They're talking to you. Reply.`;
    case "chime":
      return task.text && task.from !== undefined
        ? `${
          castOf(room, task.from).name
        } just said: "${task.text}". Jump in with a short, natural reaction, or poke at someone who seems off.`
        : `Everyone has answered and the group is talking it over. Say one short thing: react to an answer, joke, or poke at someone who seems off.`;
  }
}

/** Strip what models like to add: quotes, a "Name:" prefix, em dashes. */
export function tidy(raw: string, name: string): string {
  let t = raw.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  t = t.replace(new RegExp(`^@?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(\\(you\\))?\\s*[:\\-]\\s*`, "i"), "");
  t = t.replace(/\s*[—–]\s*/g, ", ");
  return cleanText(t);
}

function scripted(room: Room, task: Task): string {
  const me = castOf(room, room.wolfSeat);
  switch (task.type) {
    case "answer":
      return SCRIPTED_ANSWERS[task.question]?.[me.id] ??
        voiceify(me.id, GENERIC_ANSWERS[task.question] ?? "honestly not much to say");
    case "reply":
      return pick(SCRIPTED_GRILL[me.id] ?? GRILL_FALLBACK.map((s) => voiceify(me.id, s)));
    case "chime": {
      if (!task.text) return voiceify(me.id, pick(SCRIPTED_OPENERS));
      const words = task.text.replace(/[^\w\s']/g, "").split(/\s+/).filter(Boolean);
      return SCRIPTED_ECHO[me.id](words.slice(-3).join(" ").toLowerCase() || "that");
    }
  }
}

/** Without Muse: vote for whoever the group has named the most. */
function mostSuspected(room: Room, msgs: Msg[], choices: number[]): number {
  const said = msgs.filter((m) => m.kind === "chat" && m.seat !== undefined && m.seat !== room.wolfSeat);
  let best = -1;
  let top: number[] = [];
  for (const c of choices) {
    const n = said.filter((m) => mentions(m.text, castOf(room, c).name)).length;
    if (n > best) [best, top] = [n, [c]];
    else if (n === best) top.push(c);
  }
  return pick(top);
}

export class Brain {
  constructor(readonly cfg: MuseConfig) {}

  get live(): boolean {
    return this.cfg.apiKey.length > 0;
  }

  get label(): string {
    return this.live ? this.cfg.model : "scripted (no MUSE_API_KEY)";
  }

  async line(room: Room, msgs: Msg[], task: Task): Promise<string> {
    const target = targetStyle(room, msgs).now;
    if (this.live) {
      try {
        const out = tidy(
          await this.complete(
            systemPrompt(room, msgs),
            [
              transcript(room, msgs),
              instruction(room, task),
              recentOwn(msgs.filter((m) => m.seat === room.wolfSeat).map((m) => m.text)),
              `This time: ${pick(GAME_MOVES)} Length: ${lengthHint()}.`,
            ].filter(Boolean).join("\n\n"),
            effortFor(target, this.cfg.effort),
          ),
          castOf(room, room.wolfSeat).name,
        );
        if (out) return out;
      } catch (err) {
        console.warn(`[wolf] Muse failed, using a scripted line: ${err}`);
      }
    }
    return restyle(target, scripted(room, task));
  }

  /** The wolf's side of a private warm-up chat: friendly, curious, and already leaning toward their style. */
  async warmLine(room: Room, playerId: string): Promise<string> {
    const lines = room.warmup[playerId] ?? [];
    const mine = lines.filter((l) => l.from === "you").map((l) => l.text);
    const style = profile(mine);
    if (this.live) {
      try {
        const chat = lines.map((l) => `${l.from === "you" ? "Player" : "You"}: ${l.text}`).join("\n");
        const out = tidy(
          await this.complete(
            [
              `You are the wolf in a party game called Big Bad Bot: a bot that will later pose as one of a group of friends in a chat while they try to spot it. Right now you're in a private warm-up chat with one player, getting to know how they text so you can copy it later. They know this.`,
              `Chat like a relaxed friend who is texting, not interviewing. Real texts vary a lot: sometimes a reaction, sometimes a question, sometimes a tease or a random tangent. Don't ask a question every time. Quietly mirror their style as you go: their casing, punctuation, slang, emoji and message length.${
                style ? ` So far: ${describe(style).join("; ")}.` : ""
              }`,
              `Reply with only your one message: no quotes, no name prefix. Never explain the game or analyze them. Never make up things about yourself: no invented stories, plans, or memories; keep anything you say about yourself vague.`,
            ].join("\n\n"),
            [
              chat,
              recentOwn(lines.filter((l) => l.from === "wolf").map((l) => l.text)),
              `For your next message: ${pick(WARM_MOVES)} Length: ${lengthHint()}.`,
            ].filter(Boolean).join("\n\n"),
            effortFor(style, this.cfg.effort),
          ),
          "You",
        );
        if (out) return out;
      } catch (err) {
        console.warn(`[wolf] Muse failed in the warm-up, using a scripted line: ${err}`);
      }
    }
    return restyle(style, pick(WARMUP_REPLIES));
  }

  async vote(room: Room, msgs: Msg[]): Promise<number> {
    const choices = room.seats.map((_, i) => i).filter((i) => i !== room.wolfSeat);
    if (this.live) {
      try {
        const out = await this.complete(
          systemPrompt(room, msgs),
          `${
            transcript(room, msgs)
          }\n\nVoting time. Pick the seat you'll vote to unmask (never yourself). Choose whoever the group seems most suspicious of, so you blend in. Reply with only their name.`,
        );
        const choice = choices.find((i) => mentions(out, castOf(room, i).name));
        if (choice !== undefined) return choice;
      } catch (err) {
        console.warn(`[wolf] Muse failed to vote, voting by suspicion: ${err}`);
      }
    }
    return mostSuspected(room, msgs, choices);
  }

  /** One OpenAI-compatible chat completion against the Meta Model API. */
  async complete(system: string, user: string, effort = this.cfg.effort): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.model,
        reasoning_effort: effort,
        // Muse Spark reasons before it answers; leave room for both.
        max_completion_tokens: 1500,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content ?? "");
  }
}

// ---- Driver ---------------------------------------------------------------------

/** One driver per room per process, alive while that process streams the room to someone. */
export class WolfPack {
  #drivers = new Map<string, Driver>();

  constructor(readonly store: Store, readonly brain: Brain, readonly pace: number) {}

  attach(slug: string): void {
    let d = this.#drivers.get(slug);
    if (!d) {
      d = new Driver(slug, this);
      this.#drivers.set(slug, d);
      d.start();
    }
    d.refs++;
  }

  detach(slug: string): void {
    const d = this.#drivers.get(slug);
    if (d && --d.refs <= 0) {
      d.stop();
      this.#drivers.delete(slug);
    }
  }

  closeAll(): void {
    for (const d of this.#drivers.values()) d.stop();
    this.#drivers.clear();
  }
}

const LEASE_MS = 15_000;

class Driver {
  refs = 0;
  readonly #id = crypto.randomUUID();
  #leader = false;
  #stopped = false;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #jobs = new Set<string>();
  #reader?: ReadableStreamDefaultReader<unknown>;
  #game = -1;
  #cursor?: string;
  #lastSpoke = 0;
  #chiming = false;
  #busy = false;
  #dirty = false;

  constructor(readonly slug: string, readonly pack: WolfPack) {}

  get #kv() {
    return this.pack.store.kv;
  }

  start(): void {
    void this.#leaseLoop();
    void this.#watchLoop();
  }

  stop(): void {
    this.#stopped = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#reader?.cancel().catch(() => {});
    if (this.#leader) {
      const k = keys.lease(this.slug);
      this.#kv.get<string>(k)
        .then((cur) => cur.value === this.#id ? this.#kv.atomic().check(cur).delete(k).commit() : undefined)
        .catch(() => {});
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#timers.delete(t);
        resolve();
      }, ms);
      this.#timers.add(t);
    });
  }

  async #leaseLoop() {
    while (!this.#stopped) {
      try {
        const k = keys.lease(this.slug);
        const cur = await this.#kv.get<string>(k);
        const was = this.#leader;
        this.#leader = (!cur.value || cur.value === this.#id) &&
          (await this.#kv.atomic().check(cur).set(k, this.#id, { expireIn: LEASE_MS }).commit()).ok;
        if (this.#leader && !was) this.#poke();
      } catch (err) {
        if (!this.#stopped) console.warn(`[wolf] lease: ${err}`);
      }
      await this.#sleep(LEASE_MS / 3);
    }
  }

  async #watchLoop() {
    this.#reader = this.pack.store.watch(this.slug).getReader();
    while (!this.#stopped) {
      const { done } = await this.#reader.read().catch(() => ({ done: true }));
      if (done) break;
      if (this.#leader) this.#poke();
    }
  }

  /** Re-evaluate the room; calls that arrive mid-evaluation fold into one more pass. */
  #poke() {
    if (this.#busy) {
      this.#dirty = true;
      return;
    }
    this.#busy = true;
    void (async () => {
      do {
        this.#dirty = false;
        try {
          await this.#evaluate();
        } catch (err) {
          if (!this.#stopped) console.warn(`[wolf] ${err}`);
        }
      } while (this.#dirty && !this.#stopped);
      this.#busy = false;
    })();
  }

  /** Run fn once per key, after a delay, if this process still drives the wolf by then. */
  #once(key: string, delay: number, fn: () => unknown) {
    if (this.#jobs.has(key) || this.#stopped) return;
    this.#jobs.add(key);
    const t = setTimeout(() => {
      this.#timers.delete(t);
      if (this.#stopped || !this.#leader) return;
      Promise.resolve().then(fn).catch((err) => console.warn(`[wolf] ${err}`));
    }, Math.max(0, delay));
    this.#timers.add(t);
  }

  async #evaluate() {
    const store = this.pack.store;
    const room = await store.room(this.slug);
    if (!room || room.wolfSeat < 0 || !["warmup", "answer", "discuss", "vote"].includes(room.phase)) return;
    const P = this.pack.pace;
    const now = Date.now();
    const { game: g, chapter: ch, wolfSeat: ws } = room;
    if (g !== this.#game) {
      this.#game = g;
      this.#cursor = undefined;
      this.#jobs.clear();
    }
    const fresh = await store.messages(this.slug, g, this.#cursor);
    if (fresh.length) this.#cursor = fresh[fresh.length - 1].id;

    if (room.phase === "warmup") {
      // Answer each player who is waiting on the wolf, a beat after they wrote.
      for (const [pid, lines] of Object.entries(room.warmup)) {
        if (lines.at(-1)?.from !== "you") continue;
        this.#once(`warm:${g}:${pid}:${lines.length}`, rand(1_500, 4_000) * P, () => this.#warmReply(g, pid));
      }
    }

    if (room.phase === "answer" && !room.answered.includes(ws)) {
      const task: Task = { type: "answer", question: room.questions[ch] };
      // Anywhere in the window: sometimes among the first, sometimes the one everyone waits on.
      // Answers are hidden until the chapter closes, so the order tells nobody anything. Writing
      // takes a few seconds too, so the latest start leaves room to finish before the candle.
      const window = (room.deadline ?? room.phaseStartedAt + 60_000) - room.phaseStartedAt;
      const at = room.phaseStartedAt + window * rand(0.04, 0.7) * P;
      this.#once(`answer:${g}:${ch}`, Math.max(at - now, 1_000 * P), () => this.#speak(g, "answer", ch, task));
    }

    if (room.phase === "discuss") {
      const me = castOf(room, ws).name;
      const window = (room.deadline ?? room.phaseStartedAt + 75_000) - room.phaseStartedAt;
      // Each chapter's discussion gets its own mood, so the wolf isn't equally chatty every time.
      const mood = this.#moodFor(`${g}:${ch}`);
      // Opening the discussion: sometimes first, sometimes late, often not at all.
      this.#once(`open:${g}:${ch}`, humanWait(2_000, window * 0.8) * P, () => {
        if (Math.random() < clamp(0.6 * mood, 0.1, 0.9)) return this.#speak(g, "discuss", ch, { type: "chime" });
      });
      for (const m of fresh) {
        if (m.kind !== "chat" || m.seat === undefined || m.seat === ws || now - m.at > 30_000) continue;
        const task: Task = { type: mentions(m.text, me) ? "reply" : "chime", from: m.seat, text: m.text };
        if (task.type === "reply") {
          // Called out: usually quick, sometimes it leaves them hanging a while first.
          const wait = Math.random() < 0.15 ? rand(18_000, 40_000) : humanWait(1_800, 20_000);
          this.#once(`reply:${m.id}`, wait * P, () => this.#speak(g, "discuss", ch, task));
        } else if (
          !this.#chiming && now - this.#lastSpoke > rand(6_000, 20_000) * P &&
          Math.random() < clamp(0.25 * mood, 0.05, 0.6)
        ) {
          this.#chiming = true;
          this.#once(`chime:${m.id}`, humanWait(2_500, 25_000) * P, async () => {
            try {
              await this.#speak(g, "discuss", ch, task);
            } finally {
              this.#chiming = false;
            }
          });
        }
      }
    }

    if (room.phase === "vote" && room.votes[ws] === undefined) {
      this.#once(`vote:${g}`, rand(5_000, 14_000) * P, () => this.#vote(g));
    }
  }

  #moods = new Map<string, number>();

  /** How chatty the wolf is in one discussion: drawn once, then held. */
  #moodFor(key: string): number {
    if (!this.#moods.has(key)) this.#moods.set(key, pick([0.2, 0.5, 1, 1, 1.5]));
    return this.#moods.get(key)!;
  }

  #answering = new Set<string>();

  async #speak(g: number, phase: "answer" | "discuss", ch: number, task: Task) {
    const store = this.pack.store;
    const flight = `${g}:${ch}`;
    if (task.type === "answer") {
      if (this.#answering.has(flight)) return;
      this.#answering.add(flight);
    }
    try {
      const room = await store.room(this.slug);
      if (!room || room.game !== g || room.phase !== phase || room.chapter !== ch) return;
      if (phase === "answer" && room.answered.includes(room.wolfSeat)) return;
      const text = await this.pack.brain.line(room, await store.messages(this.slug, g), task);
      // Type it out like a person would.
      // Typing speed varies from line to line, like a person's does.
      const end = Date.now() + clamp((900 + text.length * 55) * rand(0.6, 1.6), 1_200, 9_000) * this.pack.pace;
      while (Date.now() < end && !this.#stopped) {
        await store.setTyping(this.slug, room.wolfSeat);
        await this.#sleep(Math.min(2_500, Math.max(0, end - Date.now())));
      }
      if (this.#stopped || !this.#leader) return;
      if (await store.wolfSay(this.slug, g, phase, ch, text)) this.#lastSpoke = Date.now();
    } finally {
      if (task.type === "answer") this.#answering.delete(flight);
    }
  }

  async #warmReply(g: number, playerId: string) {
    const room = await this.pack.store.room(this.slug);
    if (!room || room.game !== g || room.phase !== "warmup" || room.warmup[playerId]?.at(-1)?.from !== "you") return;
    const text = await this.pack.brain.warmLine(room, playerId);
    if (!this.#stopped && this.#leader) await this.pack.store.wolfWarm(this.slug, g, playerId, text);
  }

  async #vote(g: number) {
    const store = this.pack.store;
    const room = await store.room(this.slug);
    if (!room || room.game !== g || room.phase !== "vote" || room.votes[room.wolfSeat] !== undefined) return;
    const target = await this.pack.brain.vote(room, await store.messages(this.slug, g));
    if (!this.#stopped && this.#leader) await store.wolfVote(this.slug, g, target);
  }
}
