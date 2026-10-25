// The wolf: a Claude agent sitting in one seat, pretending to be a friend.
//
// Brain   writes the wolf's lines and picks its vote with Claude: Haiku, unless the
//         WOLF_MODEL env var picks Sonnet or Opus. There is no stand-in: when Claude
//         can't play, the Brain throws and the room shows why.
// Driver  decides when the wolf speaks and votes. It reacts to the room's state
//         rather than to requests, so any server process can pick it up: one
//         process per room holds a short KV lease and drives the wolf.

import Anthropic from "@anthropic-ai/sdk";
import { castOf, cleanText, mentions, type Msg, type Room, warmSamples } from "./game.ts";
import { describe, profile } from "./style.ts";
import { keys, type Store } from "./store.ts";

/**
 * The models WOLF_MODEL can pick, by name. Haiku is the default because the key bills a
 * personal account. Bigger models get longer to answer before the wolf gives up on a move.
 */
export const WOLF_MODELS = {
  haiku: { id: "claude-haiku-5-5", timeoutMs: 15_000 },
  sonnet: { id: "claude-sonnet-5-5", timeoutMs: 20_000 },
  opus: { id: "claude-opus-5-5", timeoutMs: 25_000 },
} as const;
export type WolfModel = keyof typeof WOLF_MODELS;

/** " Opus" -> "opus", unset or empty -> "haiku", anything else -> null. */
export function wolfModel(raw: string | undefined): WolfModel | null {
  const name = (raw ?? "").trim().toLowerCase() || "haiku";
  return Object.hasOwn(WOLF_MODELS, name) ? name as WolfModel : null;
}

/** Sonnet and Opus can decline at their safety checks; this beta reruns a declined line on another model. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface ClaudeConfig {
  apiKey: string;
  /** The WOLF_MODEL env var: "haiku" (the default), "sonnet" or "opus". */
  model: string;
  /** "low" keeps lines quick on every model. */
  effort: "low" | "medium" | "high";
  /** Only tests point this elsewhere (a fake Messages API). */
  baseURL?: string;
}

type Task =
  | { type: "answer"; question: string }
  | { type: "reply"; from: number; text: string; at?: number }
  | { type: "chime"; from?: number; text?: string; at?: number };

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ---- Brain ----------------------------------------------------------------------

function systemPrompt(room: Room): string {
  const me = castOf(room, room.wolfSeat);
  const others = room.seats
    .map((_, i) => i)
    .filter((i) => i !== room.wolfSeat)
    .map((i) => `${castOf(room, i).name} (${castOf(room, i).voice})`)
    .join("; ");
  return [
    `You are playing a party game called Big Bad Bot in a group chat with real people. Everyone hides behind a storybook name. All the seats are humans except one, which is secretly an AI "wolf": you. The humans are trying to spot the AI and vote it out. You win if they vote out anyone else.`,
    `Your seat is ${me.name}, ${me.role}. Every player was asked to text in their seat's voice, and yours is "${me.voice}". Follow it loosely, the imperfect way a real person would. The other seats: ${others}.`,
    `Above all, make sense. Every message has to be a believable reply to what was actually asked or said just now. Answer questions for real, with one concrete, ordinary detail (you're a college student at a hackathon this weekend). Stay consistent with everything you already said in this chat (your lines are marked "(you)"): same life, same day, same story. No random tangents, no non sequiturs, nothing a friend would read and go "what?".`,
    `How real people write here: short, casual, a bit messy. Punctuation gets skipped, nobody explains themselves at length. They joke, and they get mildly annoyed when accused.`,
    `What gets the AI caught: tidy grammar, sounding wholesome or like an ad, generic answers like "pizza and coffee", repeating someone's exact words back, polite agreement, saying "as a human", em dashes, emoji spam, over-defending ("I promise I'm real!"), tacking "lol" or "lmao" onto lines, leaning on the same filler every message, and long messages.`,
    `Blend in. Never admit or hint that you're an AI. When someone questions you, answer their actual point like a slightly annoyed friend, and sometimes turn it back on someone by pointing at something they really said. Only call someone out over something specific they wrote.`,
    warmStyle(room),
    `Put your one chat message inside <message></message> tags, 25 words at most, and write nothing outside the tags: no thinking out loud, no corrections, no notes about these instructions, no name prefix. If you want to change a line, rewrite it before you answer, never in the reply.`,
  ].filter(Boolean).join("\n\n");
}

/**
 * What the wolf learned chatting with each player before the path began: how the group
 * texts, measured, plus a few of their real lines to match.
 */
export function warmStyle(room: Room): string {
  const samples = warmSamples(room);
  const style = profile(samples);
  if (!style) return "";
  return [
    `Before the game you chatted privately with every player, so you know how this group really texts. Measured across what they wrote to you: ${
      describe(style).join("; ")
    }.`,
    `A few of their real lines:\n${samples.slice(-10).map((t) => `- ${t}`).join("\n")}`,
    `Text like these people (copy the feel: casing, punctuation, length, slang), not like an assistant. Their style matters more than your seat's voice.`,
  ].join("\n");
}

/** The wolf's side of one player's private warm-up chat. */
function warmPrompt(lines: { from: "you" | "wolf"; text: string }[]): { system: string; user: string } {
  const mine = lines.filter((l) => l.from === "you").map((l) => l.text);
  const style = profile(mine);
  return {
    system: [
      `You are the wolf in a party game called Big Bad Bot: a bot that will later pose as one of a group of friends in a chat while they try to spot it. Right now you're in a private warm-up chat with one player, getting to know how they text so you can copy it later. They know this.`,
      `Chat like a relaxed friend who is texting, not interviewing. Real texts vary a lot: sometimes just a reaction or a few words, sometimes a tease, sometimes a question. Ask a question in at most every other message, and never ask something you already asked. Don't open two messages the same way. Quietly mirror their style as you go: their casing, punctuation, emoji and message length, but use their slang only once in a while, not in every line.${
        style ? ` So far: ${describe(style).join("; ")}.` : ""
      }`,
      `Keep it short, like a text. Never explain the game or analyze them. Never say what you're doing or about to do, and never make up stories, plans or a day of your own: you're a bot getting to know them, so keep anything about yourself vague.`,
      `Put your one message inside <message></message> tags, 20 words at most, and write nothing outside the tags: no thinking out loud, no corrections, no notes about these instructions, no name prefix.`,
    ].join("\n\n"),
    user: `${lines.map((l) => `${l.from === "you" ? "Player" : "You"}: ${l.text}`).join("\n")}\n\n${
      lines.length > 1 ? "Your next message should differ in shape and opener from yours above. " : ""
    }Write your next message.`,
  };
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

/** How the humans in this room actually write, so the wolf copies them rather than a stereotype. */
export function styleNotes(room: Room, msgs: Msg[]): string {
  const said = msgs.filter((m) =>
    (m.kind === "chat" || m.kind === "answer") && m.seat !== undefined && m.seat !== room.wolfSeat
  );
  if (!said.length) return "";
  const words = said.map((m) => m.text.split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
  const median = words[Math.floor(words.length / 2)];
  const share = (f: (t: string) => boolean) => said.filter((m) => f(m.text)).length / said.length;
  const lower = share((t) => t === t.toLowerCase());
  const bare = share((t) => !/[.!?]$/.test(t));
  const examples = said.slice(-8).map((m) => `${castOf(room, m.seat!).name}: ${m.text}`).join("\n");
  return [
    `How the real people here are writing (match this, it matters more than your seat's voice):`,
    `- usually about ${median} word${
      median === 1 ? "" : "s"
    } a message, so keep yours around that length, as long as it still makes sense`,
    `- ${Math.round(lower * 100)}% write all lowercase, ${Math.round(bare * 100)}% skip the final punctuation`,
    `- their latest lines, for tone, slang and messiness (copy the feel, never the words):\n${examples}`,
  ].join("\n");
}

function instruction(room: Room, task: Task): string {
  const question = room.questions[room.chapter];
  switch (task.type) {
    case "answer":
      return `Answer this chapter's question now: "${task.question}". Give a real, plausible answer with one specific detail that fits what you've said before. If others already answered, match them: same length, same level of effort.`;
    case "reply":
      return `${
        castOf(room, task.from).name
      } just said to you: "${task.text}". Reply to exactly that. If it's an accusation, answer their actual point, using your earlier answers if that helps.`;
    case "chime":
      return task.text && task.from !== undefined
        ? `${
          castOf(room, task.from).name
        } just said: "${task.text}". React to that the way a friend in this chat would: agree, push back, joke about it, or ask a follow-up. Stay on what they said.`
        : `Everyone has answered "${question}" and the group is talking it over. Say one short thing about one of those answers: what stood out, what sounds made up, or a joke about it.`;
  }
}

/** Strip what models like to add: quotes, a "Name:" prefix, em dashes. */
export function tidy(raw: string, name: string): string {
  let t = raw.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  t = t.replace(new RegExp(`^@?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(\\(you\\))?\\s*[:\\-]\\s*`, "i"), "");
  t = t.replace(/\s*[—–]\s*/g, ", ");
  return cleanText(t);
}

/** Talk about the instructions or about fixing a line: it belongs in Claude's head, never in the chat. */
const META =
  /\b(the instructions?|my instructions|system prompt|i need to (correct|fix|rewrite|redo)|let me (correct|rewrite|fix|redo|try again)|(corrected|revised|rewritten|fixed|final) (message|version|line|reply)|here(?:'s| is) (the|my|a) (corrected|revised|rewritten|new|final)|as an ai)\b/i;

/** Claude's reply wasn't a clean chat line (no tags, or talk about its instructions, or a refusal). */
export class NotALineError extends Error {}

/**
 * The wolf's chat line out of Claude's reply: the text inside the last <message> tag, so a reply
 * that thinks aloud or corrects itself posts only its final line. A reply with no tag at all (for
 * example Claude declining the task in plain words) is never used as a line, and neither is one
 * that talks about the instructions: it throws, so nothing that gives the wolf away is posted.
 */
export function parseLine(raw: string): string {
  const tagged = [...raw.matchAll(/<message>([\s\S]*?)<\/message>/gi)].map((m) => m[1].trim()).filter(Boolean);
  // A tag that was opened but never closed (the reply ran out): what follows it is still the line.
  const open = tagged.length ? "" : /<message>([\s\S]*)$/i.exec(raw)?.[1].trim() ?? "";
  const text = tagged.at(-1) ?? open;
  if (!text) {
    throw new NotALineError(
      `Claude didn't put a chat line in <message> tags (${JSON.stringify(raw.trim().slice(0, 80))}).`,
    );
  }
  if (META.test(text)) {
    throw new NotALineError(
      `Claude's reply talked about its instructions instead of chatting (${JSON.stringify(text.slice(0, 80))}).`,
    );
  }
  return text;
}

const LAUGH = /\b(lol|lmao|haha+)\b/i;

/** Models tack "lol" onto everything; people don't. Drop it when the wolf laughed in one of its last few lines. */
export function easeLaughs(text: string, recent: string[]): string {
  if (!recent.slice(-3).some((t) => LAUGH.test(t))) return text;
  const out = text.replace(/\s*\b(lol|lmao|haha+)\b[.!]*/gi, "").replace(/^[\s,]+/, "").trim();
  return out || text;
}

/**
 * A last look at the tally before the wolf votes. The wolf only loses with strictly
 * the most votes, so when friends are on it, it backs their top other pick to force a
 * tie; when friends are piling onto someone else, it usually joins in.
 */
export function finalVote(room: Room, planned: number, roll = Math.random()): number {
  const tally = new Map<number, number>();
  for (const [from, to] of Object.entries(room.votes)) {
    if (Number(from) !== room.wolfSeat) tally.set(to, (tally.get(to) ?? 0) + 1);
  }
  const [lead, n] = [...tally].filter(([s]) => s !== room.wolfSeat).sort((a, b) => b[1] - a[1])[0] ?? [-1, 0];
  if ((tally.get(room.wolfSeat) ?? 0) > 0) return lead >= 0 ? lead : planned;
  if (n >= 2 && roll < 0.6) return lead;
  return planned;
}

export class Brain {
  readonly #client: Anthropic;
  readonly #choice: WolfModel | null;

  constructor(readonly cfg: ClaudeConfig) {
    this.#choice = wolfModel(cfg.model);
    this.#client = new Anthropic({
      apiKey: cfg.apiKey,
      // Only the key from server/keys.ts: never a token or base URL that happens to be in the environment.
      authToken: null,
      baseURL: cfg.baseURL ?? "https://api.anthropic.com",
      timeout: this.#timeoutMs,
      // The SDK retries 429s, 5xx and dropped connections itself; once is enough for a live game.
      maxRetries: 1,
    });
  }

  get #timeoutMs(): number {
    return WOLF_MODELS[this.#choice ?? "haiku"].timeoutMs;
  }

  /** The model the wolf calls, e.g. "claude-haiku-5-5". */
  get model(): string {
    return WOLF_MODELS[this.#choice ?? "haiku"].id;
  }

  get live(): boolean {
    return this.cfg.apiKey.length > 0;
  }

  /** Why Claude can't play at all on this server, or null when it can. */
  get problem(): string | null {
    if (!this.#choice) return `WOLF_MODEL is "${this.cfg.model}": set it to haiku, sonnet or opus.`;
    return this.live ? null : "Claude isn't connected: there's no Anthropic API key in server/keys.ts.";
  }

  get label(): string {
    return this.problem ?? `${this.model} (WOLF_MODEL=${this.#choice}, effort ${this.cfg.effort})`;
  }

  async line(room: Room, msgs: Msg[], task: Task): Promise<string> {
    const me = castOf(room, room.wolfSeat);
    let out = tidy(
      await this.chat(
        systemPrompt(room),
        [transcript(room, msgs), styleNotes(room, msgs), instruction(room, task)].filter(Boolean).join("\n\n"),
      ),
      me.name,
    );
    // Laughing is the voice for some seats; for everyone else, keep it occasional.
    if (!LAUGH.test(me.voice)) {
      out = easeLaughs(out, msgs.filter((m) => m.seat === room.wolfSeat && m.kind !== "chap").map((m) => m.text));
    }
    if (!out) throw new Error("Claude sent back an empty message.");
    return out;
  }

  /** One chat line from Claude. A reply that isn't one (no tags, a refusal, talk about the prompt) gets one more try. */
  async chat(system: string, user: string): Promise<string> {
    for (let attempt = 0;; attempt++) {
      const raw = await this.complete(system, user);
      try {
        return parseLine(raw);
      } catch (err) {
        if (!(err instanceof NotALineError) || attempt >= 1) throw err;
        console.warn(`[wolf] ${err.message} Asking again.`);
      }
    }
  }

  /** The wolf's reply in a player's private warm-up chat. Throws when Claude can't write one. */
  async warmLine(room: Room, playerId: string): Promise<string> {
    const { system, user } = warmPrompt(room.warmup[playerId] ?? []);
    const out = tidy(await this.chat(system, user), "You");
    if (!out) throw new Error("Claude sent back an empty message.");
    return out;
  }

  async vote(room: Room, msgs: Msg[]): Promise<number> {
    const choices = room.seats.map((_, i) => i).filter((i) => i !== room.wolfSeat);
    const out = await this.complete(
      systemPrompt(room),
      `${
        transcript(room, msgs)
      }\n\nVoting time. Pick the seat you'll vote to unmask (never yourself). Usually that's whoever the group seems most suspicious of, so you blend in; someone who kept pushing on you is a fair pick too. Reply with only their name.`,
    );
    const choice = choices.find((i) => mentions(out, castOf(room, i).name));
    if (choice === undefined) {
      throw new Error(`Claude's vote didn't name anyone in the cast: ${JSON.stringify(out.slice(0, 80))}.`);
    }
    return choice;
  }

  /** One Messages API call to the chosen Claude model. Throws a readable error on failure. */
  async complete(system: string, user: string): Promise<string> {
    const problem = this.problem;
    if (problem) throw new Error(problem);
    // Haiku has no server-side fallback; Sonnet and Opus rerun a declined line on the model
    // Anthropic recommends for that kind of decline.
    const fallback = this.#choice !== "haiku";
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.#client.beta.messages.create({
        model: this.model,
        // These models think before they answer (adaptive, on by default); leave room for
        // that plus a one-line reply.
        max_tokens: 4096,
        output_config: { effort: this.cfg.effort },
        system,
        messages: [{ role: "user", content: user }],
        ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      });
    } catch (err) {
      throw new Error(explain(err, this.#timeoutMs));
    }
    // "refusal" here means the fallback declined too (or there was none, on Haiku).
    if (res.stop_reason === "refusal") {
      throw new Error(`Claude declined to write the wolf's line (${res.stop_details?.category ?? "refusal"}).`);
    }
    // A reply can start with thinking blocks: read the text blocks by type, not position.
    const text = res.content.flatMap((b) => b.type === "text" ? [b.text] : []).join("").trim();
    if (!text && res.stop_reason === "max_tokens") throw new Error("Claude ran out of room before it wrote a line.");
    return text;
  }
}

/** Turn an SDK error into one sentence the players can read. */
function explain(err: unknown, timeoutMs: number): string {
  const detail = (e: InstanceType<typeof Anthropic.APIError>) => {
    const body = e.error as { error?: { message?: string } } | undefined;
    return body?.error?.message ?? e.message;
  };
  if (err instanceof Anthropic.AuthenticationError) {
    return "Claude rejected the API key (HTTP 401). Check the key in server/keys.ts.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) return `Claude refused the API key (HTTP 403): ${detail(err)}`;
  if (err instanceof Anthropic.RateLimitError) return `Claude is rate-limiting this key (HTTP 429): ${detail(err)}`;
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return `Claude didn't answer within ${timeoutMs / 1000}s.`;
  }
  if (err instanceof Anthropic.APIConnectionError) return `Couldn't reach Claude: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude answered HTTP ${err.status}: ${detail(err)}`;
  return `Claude failed: ${err instanceof Error ? err.message : String(err)}`;
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
  #wolfLineAt = 0;
  #chiming = false;
  #votePlan?: { game: number; wait: number; readAt: number; capAt: number; choice: Promise<number> };
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
      this.#wolfLineAt = 0;
    }
    const fresh = await store.messages(this.slug, g, this.#cursor);
    if (fresh.length) this.#cursor = fresh[fresh.length - 1].id;

    if (room.phase === "warmup") {
      // Answer each player who is waiting on the wolf, a beat after they wrote. A failed reply is
      // reported to the room (wolfError); its timestamp is part of the key, so each failure
      // schedules a retry a few seconds later instead of leaving the player stuck.
      for (const [pid, lines] of Object.entries(room.warmup)) {
        if (lines.at(-1)?.from !== "you") continue;
        const retry = room.wolfError?.at ?? 0;
        this.#once(
          `warm:${g}:${pid}:${lines.length}:${retry}`,
          (retry ? rand(3_000, 6_000) : rand(1_500, 4_000)) * P,
          () => this.#warmReply(g, pid),
        );
      }
    }

    if (room.phase === "answer" && !room.answered.includes(ws)) {
      const task: Task = { type: "answer", question: room.questions[ch] };
      // Aim for the middle of the pack: not first, and never the one everyone waits on.
      const at = room.phaseStartedAt + rand(9_000, 24_000) * P;
      this.#once(`answer:${g}:${ch}`, Math.max(at - now, 1_500 * P), () => this.#speak(g, "answer", ch, task));
      if (room.answered.length >= room.seats.length - 1) {
        this.#once(`answer-last:${g}:${ch}`, rand(1_000, 3_000) * P, () => this.#speak(g, "answer", ch, task));
      }
    }

    if (room.phase === "discuss") {
      const me = castOf(room, ws).name;
      this.#once(`open:${g}:${ch}`, rand(5_000, 14_000) * P, () => {
        if (Math.random() < 0.6) return this.#speak(g, "discuss", ch, { type: "chime" });
      });
      for (const m of fresh) {
        if (m.kind !== "chat" || m.seat === undefined) continue;
        if (m.seat === ws) {
          this.#wolfLineAt = m.at;
          continue;
        }
        // Talking to the wolf: by name, or a "you"/question as the first line after the wolf spoke.
        const atMe = mentions(m.text, me) ||
          (m.at - this.#wolfLineAt < 20_000 && /\b(you|u|ur|your)\b|\?/i.test(m.text));
        this.#wolfLineAt = 0;
        if (now - m.at > 30_000) continue;
        const task: Task = { type: atMe ? "reply" : "chime", from: m.seat, text: m.text, at: m.at };
        if (task.type === "reply") {
          this.#once(`reply:${m.id}`, rand(1_500, 4_000) * P, () => this.#speak(g, "discuss", ch, task));
        } else if (!this.#chiming && now - this.#lastSpoke > 12_000 * P && Math.random() < 0.25) {
          this.#chiming = true;
          this.#once(`chime:${m.id}`, rand(4_000, 9_000) * P, async () => {
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
      const friends = room.seats.length - 1;
      const plan = this.#votePlan?.game === g ? this.#votePlan : (this.#votePlan = {
        game: g,
        // Let anywhere from none to all but one of the friends vote first, so the wolf isn't the one everyone waits on.
        wait: Math.floor(Math.random() * friends),
        readAt: room.phaseStartedAt + rand(3_000, 8_000) * P,
        capAt: room.phaseStartedAt + rand(12_000, 20_000) * P,
        // Ask Claude now, so its thinking time doesn't make the wolf late.
        choice: this.pack.brain.vote(room, await store.messages(this.slug, g)),
      });
      plan.choice.catch(() => {}); // a failure is reported when the vote is due, not as a crash now
      const cast = Object.keys(room.votes).filter((s) => Number(s) !== ws).length;
      if (cast >= friends || (cast >= plan.wait && now >= plan.readAt)) {
        this.#once(`vote:${g}`, rand(800, 2_500) * P, () => this.#vote(g));
      } else {
        this.#once(`vote-read:${g}`, plan.readAt - now, () => this.#poke());
        this.#once(`vote-cap:${g}`, plan.capAt - now, () => this.#vote(g));
      }
    }
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
      const msgs = await store.messages(this.slug, g);
      // Another process may have driven the wolf until a moment ago: go by the chat, not by
      // memory, so a message the wolf already answered (or a chapter it already opened) gets
      // nothing twice.
      if (task.type !== "answer") {
        const since = task.at ?? -1;
        const spoke = msgs.some((m) =>
          m.kind === "chat" && m.seat === room.wolfSeat && m.chapter === ch && m.at >= since
        );
        if (spoke) return;
      }
      // Show "is writing…" while Claude thinks, so its thinking time counts as typing time,
      // then finish typing it out like a person would.
      const started = Date.now();
      const pending = this.pack.brain.line(room, msgs, task);
      let text: string | undefined;
      let failed: unknown = null;
      const settled = pending.then((t) => void (text = t), (err) => void (failed = err ?? "unknown error"));
      const end = () =>
        failed !== null
          ? 0
          : text === undefined
          ? Infinity
          : started + clamp(900 + text.length * 55, 1_500, 7_000) * this.pack.pace;
      while (!this.#stopped && Date.now() < end()) {
        await store.setTyping(this.slug, room.wolfSeat);
        await (text === undefined && failed === null
          ? Promise.race([settled, this.#sleep(2_500)])
          : this.#sleep(Math.min(2_500, Math.max(0, end() - Date.now()))));
      }
      if (this.#stopped || !this.#leader) return;
      if (failed !== null) return await this.#failed(g, failed);
      if (text === undefined) return;
      if (await store.wolfSay(this.slug, g, phase, ch, text)) this.#lastSpoke = Date.now();
    } finally {
      if (task.type === "answer") this.#answering.delete(flight);
    }
  }

  async #warmReply(g: number, playerId: string) {
    const room = await this.pack.store.room(this.slug);
    if (!room || room.game !== g || room.phase !== "warmup" || room.warmup[playerId]?.at(-1)?.from !== "you") return;
    let text: string;
    try {
      text = await this.pack.brain.warmLine(room, playerId);
    } catch (err) {
      if (!this.#stopped && this.#leader) await this.#failed(g, err);
      return;
    }
    if (!this.#stopped && this.#leader) await this.pack.store.wolfWarm(this.slug, g, playerId, text);
  }

  async #vote(g: number) {
    const store = this.pack.store;
    let room = await store.room(this.slug);
    if (!room || room.game !== g || room.phase !== "vote" || room.votes[room.wolfSeat] !== undefined) return;
    let planned: number;
    try {
      planned = await (this.#votePlan?.game === g
        ? this.#votePlan.choice
        : this.pack.brain.vote(room, await store.messages(this.slug, g)));
    } catch (err) {
      if (!this.#stopped && this.#leader) await this.#failed(g, err);
      return;
    }
    room = await store.room(this.slug);
    if (!room || room.game !== g || room.phase !== "vote") return;
    if (!this.#stopped && this.#leader) await store.wolfVote(this.slug, g, finalVote(room, planned));
  }

  /** Claude couldn't play this move: put the reason on the room so every player sees it. */
  async #failed(g: number, err: unknown) {
    const text = err instanceof Error ? err.message : String(err);
    console.warn(`[wolf ${this.slug}] ${text}`);
    await this.pack.store.wolfFailed(this.slug, g, text);
  }
}
