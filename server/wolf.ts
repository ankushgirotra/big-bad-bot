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
  SCRIPTED_GRILL,
  SCRIPTED_OPENERS,
  SCRIPTED_REACTIONS,
  voiceify,
} from "./cast.ts";
import { castOf, cleanText, mentions, type Msg, type Room } from "./game.ts";
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
    `What gets the AI caught: tidy grammar, sounding wholesome or like an ad, generic answers like "pizza and coffee", repeating someone's exact words back, polite agreement, saying "as a human", em dashes, emoji spam, over-defending ("I promise I'm real!"), and long messages.`,
    `Blend in. Never admit or hint that you're an AI. When someone questions you, answer their actual point like a slightly annoyed friend, and sometimes turn it back on someone by pointing at something they really said. Only call someone out over something specific they wrote.`,
    `Reply with only the text of your one chat message: no quotes, no name prefix, 25 words at most.`,
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
    `- usually about ${median} word${median === 1 ? "" : "s"} a message, so keep yours around that length, as long as it still makes sense`,
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

function scripted(room: Room, task: Task): string {
  const me = castOf(room, room.wolfSeat);
  switch (task.type) {
    case "answer":
      return SCRIPTED_ANSWERS[task.question]?.[me.id] ??
        voiceify(me.id, GENERIC_ANSWERS[task.question] ?? "honestly not much to say");
    case "reply":
      return pick(SCRIPTED_GRILL[me.id] ?? GRILL_FALLBACK.map((s) => voiceify(me.id, s)));
    case "chime":
      return voiceify(me.id, pick(task.text ? SCRIPTED_REACTIONS : SCRIPTED_OPENERS));
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
  constructor(readonly cfg: MuseConfig) {}

  get live(): boolean {
    return this.cfg.apiKey.length > 0;
  }

  get label(): string {
    return this.live ? this.cfg.model : "scripted (no MUSE_API_KEY)";
  }

  async line(room: Room, msgs: Msg[], task: Task): Promise<string> {
    if (this.live) {
      try {
        const out = tidy(
          await this.complete(
            systemPrompt(room),
            [transcript(room, msgs), styleNotes(room, msgs), instruction(room, task)].filter(Boolean).join("\n\n"),
          ),
          castOf(room, room.wolfSeat).name,
        );
        if (out) return out;
      } catch (err) {
        console.warn(`[wolf] Muse failed, using a scripted line: ${err}`);
      }
    }
    return scripted(room, task);
  }

  async vote(room: Room, msgs: Msg[]): Promise<number> {
    const choices = room.seats.map((_, i) => i).filter((i) => i !== room.wolfSeat);
    if (this.live) {
      try {
        const out = await this.complete(
          systemPrompt(room),
          `${
            transcript(room, msgs)
          }\n\nVoting time. Pick the seat you'll vote to unmask (never yourself). Usually that's whoever the group seems most suspicious of, so you blend in; someone who kept pushing on you is a fair pick too. Reply with only their name.`,
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
  async complete(system: string, user: string): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.model,
        reasoning_effort: this.cfg.effort,
        // Muse Spark reasons before it answers; leave room for both.
        max_completion_tokens: 1500,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      // A friend who goes quiet for longer than this looks off; fall back to a scripted line instead.
      signal: AbortSignal.timeout(10_000),
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
        const task: Task = { type: atMe ? "reply" : "chime", from: m.seat, text: m.text };
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
        // Ask Muse now, so its thinking time doesn't make the wolf late.
        choice: this.pack.brain.vote(room, await store.messages(this.slug, g)),
      });
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
      // Show "is writing…" while Muse thinks, so its thinking time counts as typing time,
      // then finish typing it out like a person would.
      const started = Date.now();
      const pending = this.pack.brain.line(room, await store.messages(this.slug, g), task);
      let text: string | undefined;
      void pending.then((t) => text = t);
      const end = () =>
        text === undefined ? Infinity : started + clamp(900 + text.length * 55, 1_500, 7_000) * this.pack.pace;
      while (!this.#stopped && Date.now() < end()) {
        await store.setTyping(this.slug, room.wolfSeat);
        await (text === undefined
          ? Promise.race([pending, this.#sleep(2_500)])
          : this.#sleep(Math.min(2_500, Math.max(0, end() - Date.now()))));
      }
      if (this.#stopped || !this.#leader || text === undefined) return;
      if (await store.wolfSay(this.slug, g, phase, ch, text)) this.#lastSpoke = Date.now();
    } finally {
      if (task.type === "answer") this.#answering.delete(flight);
    }
  }

  async #vote(g: number) {
    const store = this.pack.store;
    let room = await store.room(this.slug);
    if (!room || room.game !== g || room.phase !== "vote" || room.votes[room.wolfSeat] !== undefined) return;
    const planned = await (this.#votePlan?.game === g
      ? this.#votePlan.choice
      : this.pack.brain.vote(room, await store.messages(this.slug, g)));
    room = await store.room(this.slug);
    if (!room || room.game !== g || room.phase !== "vote") return;
    if (!this.#stopped && this.#leader) await store.wolfVote(this.slug, g, finalVote(room, planned));
  }
}
