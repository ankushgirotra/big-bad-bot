// Story data: the storybook disguises and the questions on the path.

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
