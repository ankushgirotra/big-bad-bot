// Muse's memory of one tale: a made-up backstory picked when the tale starts,
// what Muse has said so far (its claims and commitments), what it searched,
// and its research briefs.
//
// It lives at [...NS, "memory", server, game], so every tale ("read it again"
// bumps game) starts blank and no tale sees another's memory. It expires with
// the rest of the tale's data after 6 hours. The only thing that outlives a
// tale is the public search cache in research.ts, which holds no player data.

import type { Room } from "./game.ts";
import type { Brief, SearchResult } from "./research.ts";
import { keys } from "./store.ts";

const TTL = 6 * 60 * 60_000;
const SAID_MAX = 16;
const LOOKUPS_MAX = 2;

export interface Said {
  chapter: number;
  kind: "answer" | "reply" | "chime";
  text: string;
}

export interface Searched {
  query: string;
  trigger: "prematch" | "lookup";
  at: number;
  /** -1 when the search failed or was skipped. */
  results: number;
  cached: boolean;
}

export interface Memory {
  persona: string[];
  said: Said[];
  searches: Searched[];
  /** Paid searches this tale (cache hits are free). */
  spent: number;
  brief: Brief | null;
  lookups: Brief[];
}

const BACKSTORY = {
  studies: [
    "mechanical engineering",
    "economics",
    "biology",
    "computer science",
    "graphic design",
    "nursing",
    "history",
  ],
  lives: ["in a dorm with one roommate", "in an apartment off campus with two roommates", "at home and commutes in"],
  from: ["a suburb outside Houston", "a small town in the Midwest", "San Antonio", "outside Chicago", "Dallas"],
  job: ["works part-time at a coffee shop", "tutors calc on the side", "has no job this semester"],
  thing: ["drives a beat-up 2009 Corolla", "has a cat back home named Biscuit", "plays intramural volleyball"],
};

/** A small, ordinary backstory, fixed for the whole tale. */
export function newPersona(rng = Math.random): string[] {
  const pick = (xs: string[]) => xs[Math.floor(rng() * xs.length)];
  return [
    `studies ${pick(BACKSTORY.studies)}`,
    `lives ${pick(BACKSTORY.lives)}`,
    `grew up in ${pick(BACKSTORY.from)}`,
    pick(BACKSTORY.job),
    pick(BACKSTORY.thing),
    "is at a hackathon this weekend",
  ];
}

const blank = (rng: () => number): Memory => ({
  persona: newPersona(rng),
  said: [],
  searches: [],
  spent: 0,
  brief: null,
  lookups: [],
});

export class Memories {
  constructor(readonly kv: Deno.Kv, readonly rng: () => number = Math.random) {}

  /**
   * Read-modify-write one tale's memory with an optimistic check, creating it
   * on first use. fn returns false to change nothing; so does this.
   */
  async update(room: Room, fn: (m: Memory) => boolean | void): Promise<boolean> {
    const k = keys.memory(room.slug, room.game);
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await this.kv.get<Memory>(k);
      const m = entry.value ?? blank(this.rng);
      if (fn(m) === false) return false;
      if ((await this.kv.atomic().check(entry).set(k, m, { expireIn: TTL }).commit()).ok) return true;
    }
    return false;
  }

  async load(room: Room): Promise<Memory> {
    const k = keys.memory(room.slug, room.game);
    const entry = await this.kv.get<Memory>(k);
    if (entry.value) return entry.value;
    await this.update(room, () => {});
    return (await this.kv.get<Memory>(k)).value ?? blank(this.rng);
  }

  /** Take one paid search from the tale's budget; false when it's spent. */
  spend(room: Room, budget: number): Promise<boolean> {
    return this.update(room, (m) => {
      if (m.spent >= budget) return false;
      m.spent++;
    });
  }

  said(room: Room, said: Said): Promise<boolean> {
    return this.update(room, (m) => void (m.said = [...m.said, said].slice(-SAID_MAX)));
  }

  searched(room: Room, query: string, trigger: Searched["trigger"], r: SearchResult | null): Promise<boolean> {
    const entry = { query, trigger, at: Date.now(), results: r ? r.hits.length : -1, cached: r?.cached ?? false };
    return this.update(room, (m) => void m.searches.push(entry));
  }

  setBrief(room: Room, brief: Brief): Promise<boolean> {
    return this.update(room, (m) => void (m.brief = brief));
  }

  addLookup(room: Room, brief: Brief): Promise<boolean> {
    return this.update(room, (m) => void (m.lookups = [...m.lookups, brief].slice(-LOOKUPS_MAX)));
  }
}

/** The memory as it appears in the prompt. */
export function renderMemory(m: Memory): string {
  const lines = [
    "Your private notes for this tale (only you see them):",
    `Your made-up backstory, fixed for this tale; bring it up only when it fits: you ${m.persona.join(", ")}.`,
  ];
  if (m.said.length) {
    lines.push(
      "What you've already said this tale. These are your claims: never contradict them, and don't reuse the wording:",
    );
    for (const s of m.said) lines.push(`- chapter ${s.chapter + 1}, ${s.kind}: "${s.text}"`);
  }
  return lines.join("\n");
}
