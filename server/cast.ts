// Story data: the storybook disguises, the questions on the path, and the
// scripted wolf's lines (used when no Muse key is set, or Muse fails).

export interface CastMember {
  id: string;
  name: string;
  role: string;
  color: string;
  /** The texting voice every player in this seat is asked to write in. */
  voice: string;
}

// The first five come straight from the design; the last three let up to
// seven friends play (plus the wolf's seat).
export const CAST: CastMember[] = [
  { id: "maya", name: "maya", role: "the baker's girl", color: "#9c3d6e", voice: "all lowercase, no punctuation" },
  { id: "dev", name: "Dev", role: "the woodcutter", color: "#3b5f8f", voice: "CAPS when excited" },
  { id: "priya", name: "Priya", role: "the miller", color: "#3d6b4f", voice: "full sentences, dry" },
  { id: "jordan", name: "jordan", role: "the hunter", color: "#5d4a8a", voice: "one word, maybe two" },
  { id: "sam", name: "Sam", role: "the shepherd", color: "#a2621f", voice: "lol + trailing dots" },
  { id: "wren", name: "Wren", role: "the weaver", color: "#2f6f73", voice: "an emoji on everything" },
  { id: "ash", name: "ash", role: "the tinker", color: "#7a3b2e", voice: "idk, tbh, abbreviations" },
  { id: "rosa", name: "Rosa", role: "the innkeeper", color: "#6b6a2a", voice: "exclamation points!!" },
];

export function castById(id: string): CastMember {
  const c = CAST.find((m) => m.id === id);
  if (!c) throw new Error(`unknown cast member ${id}`);
  return c;
}

/** How the wolf opens each player's private warm-up chat. */
export const WARMUP_OPENERS = [
  "hey, so what do you usually do on a saturday?",
  "hi! before we start, tell me what you had for lunch",
  "hey you. how's your day going so far",
  "ok quick, what's the last thing you watched",
  "yo, what are you up to right now",
];

/** The scripted wolf's warm-up replies, restyled to the player's own way of texting. */
export const WARMUP_REPLIES = [
  "ha, fair. what's your go-to snack?",
  "nice. do you text people back fast or leave them on read",
  "ok ok. what's the last thing that made you laugh",
  "same honestly. any plans this weekend?",
  "good one. what's your phone's battery at rn",
  "ha. and what do you do when you can't sleep",
];

export const CHAPTERS = ["Chapter the First", "Chapter the Second", "Chapter the Third"];

/** The third chapter always ends on the design's closing question. */
export const LAST_QUESTION = "prove you're human. go.";

export const QUESTION_POOL = [
  "what'd everyone eat today",
  "what's the last thing you lied about",
  "what's on your lock screen rn",
  "worst thing that happened to you this week",
  "what's the last song you played",
  "describe your room in five words",
  "most controversial food opinion. go",
  "what were you doing at 2am last night",
  "dumbest way you've ever gotten hurt",
  "what's the last thing you googled",
  "what's in your pockets right now",
  "who here would survive a horror movie",
];

// ---- the scripted wolf -------------------------------------------------------
// The design's wolf imitations: a little too tidy, a little too on-topic.

export const SCRIPTED_ANSWERS: Record<string, Record<string, string>> = {
  "what'd everyone eat today": {
    maya: "cold pizza for breakfast and a balanced salad for lunch no regrets",
    dev: "BRO I had three tacos and a Monster energy drink",
    priya: "I had oatmeal for breakfast and a delicious turkey sandwich for lunch!",
    jordan: "just some chips honestly, nothing crazy",
    sam: "lol I had a nice bowl of ramen... lol",
  },
  "what's the last thing you lied about": {
    maya: "told my mom i was at the library but i was actually at target shopping lmao",
    dev: "SAID I WAS 5 MINUTES AWAY. I was actually still at home!!",
    priya: "I told a small white lie to my friend about liking her haircut, haha.",
    jordan: "probably told someone i was fine when i wasnt",
    sam: "lol I told my friend I loved the gift... I did not lol",
  },
  [LAST_QUESTION]: {
    maya: "i have feelings and memories and i love my friends",
    dev: "BRO I AM 100% HUMAN. I breathe air!!",
    priya: "As a human, I enjoy walks, music, and spending time with friends.",
    jordan: "i dont have to prove anything to you guys lol",
    sam: "lol I am definitely a human person... lol",
  },
};

/** Plain answers the scripted wolf dresses up in its seat's voice. */
export const GENERIC_ANSWERS: Record<string, string> = {
  "what'd everyone eat today": "a sandwich and some coffee",
  "what's the last thing you lied about": "told someone i was almost there when i wasnt",
  "what's on your lock screen rn": "a picture of my dog at the beach",
  "worst thing that happened to you this week": "my laptop died right before a deadline",
  "what's the last song you played": "something on my discover weekly i think",
  "describe your room in five words": "messy cozy too many hoodies",
  "most controversial food opinion. go": "pineapple on pizza is actually good",
  "what were you doing at 2am last night": "scrolling on my phone instead of sleeping",
  "dumbest way you've ever gotten hurt": "tripped over my own backpack",
  "what's the last thing you googled": "how long to boil an egg",
  "what's in your pockets right now": "my phone my keys and some gum",
  "who here would survive a horror movie": "whoever answers the slowest honestly",
  [LAST_QUESTION]: "i have a body and i am tired",
};

/** When questioned directly. */
export const SCRIPTED_GRILL: Record<string, string[]> = {
  maya: [
    "i am not the wolf i am just a regular girl who loves her friends",
    "lmao why would you think that, that's crazy",
  ],
  dev: ["BRO, I am not the wolf. Trust me!!", "BRO that is a crazy accusation to make"],
  priya: [
    "I understand your concern, but I promise I'm a real person!",
    "That's a fair question! I'm definitely human.",
  ],
  jordan: ["nah im not the wolf, why would you think that", "its not me, look at the others"],
  sam: ["lol I am not a wolf... I promise lol", "lol that's funny... but no"],
};
export const GRILL_FALLBACK = [
  "not me, why would it be me",
  "i literally answered like everyone else",
  "look at the others first",
];

/** The wolf echoes your own words back to blend in. */
export const SCRIPTED_ECHO: Record<string, (s: string) => string> = {
  maya: (s) => `lmao "${s}" is so true bestie`,
  dev: (s) => `BRO "${s}" is so real!!`,
  priya: (s) => `I completely agree about "${s}"!`,
  jordan: (s) => `ya "${s}" for sure`,
  sam: (s) => `lol "${s}"... so relatable lol`,
  wren: (s) => `"${s}" so true ✨`,
  ash: (s) => `tbh "${s}" is valid`,
  rosa: (s) => `"${s}"!! love that!!`,
};

export const SCRIPTED_OPENERS = [
  "ok someone here answered way too fast",
  "not gonna lie one of those answers was weird",
  "i feel like somebody is lying",
];

/** Dress a plain line in a seat's voice. */
export function voiceify(castId: string, s: string): string {
  const bare = s.replace(/[.,!?]+$/, "");
  switch (castId) {
    case "maya":
      return bare.toLowerCase().replace(/[.,!?']/g, "");
    case "dev":
      return /^bro\b/i.test(bare) ? bare : `BRO ${bare}`;
    case "priya":
      return `${bare[0].toUpperCase()}${bare.slice(1)}.`;
    case "jordan":
      return bare.toLowerCase().split(/\s+/).slice(0, 2).join(" ");
    case "sam":
      return `lol ${bare}...`;
    case "wren":
      return `${bare} ✨`;
    case "ash":
      return `tbh ${bare.toLowerCase()}`;
    case "rosa":
      return `${bare[0].toUpperCase()}${bare.slice(1)}!!`;
    default:
      return bare;
  }
}
