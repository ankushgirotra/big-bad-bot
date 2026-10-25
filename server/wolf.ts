// The wolf: a Claude agent sitting in one seat, pretending to be a friend.
//
// Brain   writes the wolf's lines and picks its vote with Claude: Haiku, unless the
//         WOLF_MODEL env var picks Sonnet or Opus. There is no stand-in: when Claude
//         can't play, the Brain throws and the room shows why.
// Driver  decides when the wolf speaks and votes. It reacts to the room's state
//         rather than to requests, so any server process can pick it up: one
//         process per room holds a short KV lease and drives the wolf.

import Anthropic from "@anthropic-ai/sdk";
import { LAST_QUESTION, QUESTION_POOL } from "./cast.ts";
import { castOf, cleanText, mentions, type Msg, type Room } from "./game.ts";
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

/** The host is waiting on these when they start the tale; past this, the fixed list is used. */
export const QUESTION_TIMEOUT_MS = 12_000;

const QUESTION_PROMPT = [
  `You write the chapter questions for Big Bad Bot, a party game played in a group chat. Friends hide behind storybook names, and one extra seat is secretly an AI trying to pass as one of them. Each tale has three chapters: everyone answers the chapter's question in the chat, the group picks the answers apart, and at the end they vote on who the AI is.`,
  `So a good question is one where real people's answers come out specific, a little messy and personal, and an AI has to invent a life to keep up: what someone ate today, what's on their lock screen, the last thing they lied about. Anyone can answer it in one quick line from their own day, week or life, and the answers are fun to read side by side. Never invasive: nothing about trauma, health, money, politics, religion, sex or relationships, or anything you wouldn't ask a group of acquaintances.`,
  `Write them the way the host would text them to the group: all lowercase, short (about 3 to 9 words), no question mark, casual. Vary how they open, like the originals do, rather than starting each one with "what's". Use "rn" only when the question really is about right now.`,
  `Players can only type text: no photos, voice notes or links.`,
  `Chapters one and two are warm-ups about everyday life. The finale openly dares everyone to prove they're human, or that they're not the bot, like the original "${LAST_QUESTION}", with a fresh twist on how: a limit, a format, or a kind of proof only a person would have. It names being human (or the bot) outright and ends in ". go", for example "prove you're human in five words. go" or "convince us you're not the bot, no emojis allowed. go".`,
  `The originals, for style:\n${[...QUESTION_POOL, LAST_QUESTION].map((q) => `- ${q}`).join("\n")}`,
].join("\n\n");

/** Structured output: exactly three strings, in chapter order. */
const QUESTION_FORMAT: Anthropic.Beta.BetaJSONOutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      chapter_one: { type: "string" },
      chapter_two: { type: "string" },
      finale: { type: "string" },
    },
    required: ["chapter_one", "chapter_two", "finale"],
    additionalProperties: false,
  },
};

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
    `Above all, make sense. Every message has to be a believable reply to what was actually asked or said just now. Answer questions for real, with one concrete, ordinary detail (you're a college student). Stay consistent with everything you already said in this chat (your lines are marked "(you)"): same life, same day, same story. No random tangents, no non sequiturs, nothing a friend would read and go "what?".`,
    `How real people write here: short, casual, a bit messy. Punctuation gets skipped, nobody explains themselves at length. They joke, and they get mildly annoyed when accused.`,
    `What gets the AI caught: tidy grammar, sounding wholesome or like an ad, generic answers like "pizza and coffee", repeating someone's exact words back, polite agreement, saying "as a human", em dashes, emoji spam, over-defending ("I promise I'm real!"), tacking "lol" or "lmao" onto lines, leaning on the same filler every message, and long messages.`,
    `Blend in. Never admit or hint that you're an AI. When someone questions you, answer their actual point like a slightly annoyed friend, and sometimes turn it back on someone by pointing at something they really said. Only call someone out over something specific they wrote.`,
    `Reply with only the text of your one chat message: no quotes, no name prefix, 25 words at most. Completely avoid all emojis.`,
  ].join("\n\n");
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
    const raw = await this.complete(
      systemPrompt(room),
      [transcript(room, msgs), styleNotes(room, msgs), instruction(room, task)].filter(Boolean).join("\n\n"),
    );
    let out = tidy(raw, me.name);
    // Laughing is the voice for some seats; for everyone else, keep it occasional.
    if (!LAUGH.test(me.voice)) {
      out = easeLaughs(out, msgs.filter((m) => m.seat === room.wolfSeat && m.kind !== "chap").map((m) => m.text));
    }
    if (!out) throw new Error(`Claude sent back an empty message (raw: ${JSON.stringify(raw.slice(0, 80))}).`);
    return out;
  }

  /**
   * Three new chapter questions for a tale, in the spirit of the originals, from the same
   * model that plays the wolf. `recent` are the questions this server has already had.
   * Throws when the model can't write them; the caller falls back to the fixed list.
   */
  async questions(recent: string[]): Promise<string[]> {
    const ask = recent.length
      ? `Write the three questions for a new tale. Make them fresh: don't reuse the originals, and don't reuse or closely echo any question this group has already answered:\n${
        recent.map((q) => `- ${q}`).join("\n")
      }`
      : "Write the three questions for a new tale. Make them fresh: don't reuse the originals.";
    // One call per tale, and the rules matter more than speed here: a little more effort than chat lines.
    const raw = await this.complete(QUESTION_PROMPT, ask, {
      format: QUESTION_FORMAT,
      timeoutMs: QUESTION_TIMEOUT_MS,
      effort: "medium",
    });
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Claude's questions weren't JSON: ${JSON.stringify(raw.slice(0, 80))}`);
    }
    // The originals never end in a question mark; keep the new ones the same.
    const out = ["chapter_one", "chapter_two", "finale"].map((k) => cleanText(parsed[k], 90).replace(/\s*\?+$/, ""));
    if (out.some((q) => q.length < 6)) {
      throw new Error(`Claude's questions came back incomplete: ${JSON.stringify(out)}`);
    }
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
  async complete(
    system: string,
    user: string,
    opts: { format?: Anthropic.Beta.BetaJSONOutputFormat; timeoutMs?: number; effort?: ClaudeConfig["effort"] } = {},
  ): Promise<string> {
    const problem = this.problem;
    if (problem) throw new Error(problem);
    // Haiku has no server-side fallback; Sonnet and Opus rerun a declined line on the model
    // Anthropic recommends for that kind of decline.
    const fallback = this.#choice !== "haiku";
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.#client.beta.messages.create(
        {
          model: this.model,
          // These models think before they answer (adaptive, on by default); leave room for
          // that plus a one-line reply.
          max_tokens: 4096,
          output_config: { effort: opts.effort ?? this.cfg.effort, ...(opts.format ? { format: opts.format } : {}) },
          system,
          messages: [{ role: "user", content: user }],
          ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
        },
        // A caller with its own deadline gets one try within it, not the client's retry.
        opts.timeoutMs ? { timeout: timeoutMs, maxRetries: 0 } : undefined,
      );
    } catch (err) {
      throw new Error(explain(err, timeoutMs));
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
    if (!room || room.wolfSeat < 0 || !["answer", "discuss", "vote"].includes(room.phase)) return;
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
