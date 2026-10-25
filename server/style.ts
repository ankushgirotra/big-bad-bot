// Texting style, measured from the warm-up chat. The wolf is told what it found
// (and shown real lines) so it can write like the group; the scripted wolf
// uses restyle() to bend its canned lines the same way.

export interface Style {
  samples: number;
  avgWords: number;
  /** Share of messages with no capital letters. */
  lowercase: number;
  /** Share of messages that don't end in . ! or ?. */
  bare: number;
  exclaim: number;
  caps: number;
  dots: number;
  emoji: number;
  /** Most used emoji first. */
  emojis: string[];
  /** Slang the group actually uses, most used first. */
  slang: string[];
}

const SLANG = [
  "lol",
  "lmao",
  "idk",
  "tbh",
  "ngl",
  "rn",
  "omg",
  "bro",
  "fr",
  "lowkey",
  "haha",
  "kinda",
  "nah",
  "yeah",
  "wym",
  "bruh",
  "ig",
  "imo",
];
const EMOJI = /\p{Extended_Pictographic}/gu;

const share = (xs: string[], test: (s: string) => boolean) => xs.filter(test).length / xs.length;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const rank = (counts: Map<string, number>) => [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k);

/** Null until there's something to learn from. */
export function profile(texts: string[]): Style | null {
  const xs = texts.map((t) => t.trim()).filter(Boolean);
  if (!xs.length) return null;
  const emojis = new Map<string, number>();
  const slang = new Map<string, number>();
  for (const t of xs) {
    for (const e of t.match(EMOJI) ?? []) emojis.set(e, (emojis.get(e) ?? 0) + 1);
    for (const w of words(t.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ""))) {
      if (SLANG.includes(w)) slang.set(w, (slang.get(w) ?? 0) + 1);
    }
  }
  return {
    samples: xs.length,
    avgWords: xs.reduce((n, t) => n + words(t).length, 0) / xs.length,
    lowercase: share(xs, (t) => !/\p{Lu}/u.test(t)),
    bare: share(xs, (t) => !/[.!?]$/.test(t)),
    exclaim: share(xs, (t) => t.includes("!")),
    caps: share(xs, (t) => /\b[A-Z]{3,}\b/.test(t)),
    dots: share(xs, (t) => /\.\.+/.test(t)),
    emoji: share(xs, (t) => /\p{Extended_Pictographic}/u.test(t)),
    emojis: rank(emojis).slice(0, 3),
    slang: rank(slang).slice(0, 4),
  };
}

const most = (n: number) => n >= 0.6;

/** The style in plain sentences, for the wolf's prompt. */
export function describe(s: Style): string[] {
  const out = [
    s.avgWords <= 3
      ? "messages are tiny, a word or three"
      : s.avgWords <= 8
      ? `messages are short, about ${Math.round(s.avgWords)} words`
      : `messages run about ${Math.round(s.avgWords)} words`,
  ];
  out.push(
    most(s.lowercase)
      ? "almost never capitalizes"
      : s.lowercase < 0.2
      ? "capitalizes normally"
      : "sometimes capitalizes",
  );
  out.push(
    most(s.bare)
      ? "skips the period at the end"
      : s.bare < 0.2
      ? "ends messages with proper punctuation"
      : "punctuation is hit or miss",
  );
  if (s.exclaim >= 0.4) out.push("uses exclamation points a lot");
  if (s.caps >= 0.3) out.push("SHOUTS words in caps when excited");
  if (s.dots >= 0.3) out.push("trails off with ...");
  if (s.emoji >= 0.3) out.push(`uses emoji (${s.emojis.join(" ")})`);
  else if (s.emoji === 0) out.push("no emoji at all");
  if (s.slang.length) out.push(`slang they actually use: ${s.slang.join(", ")}`);
  return out;
}

/** Bend a finished line toward the style: for the scripted wolf, which can't be told. */
export function restyle(s: Style | null, text: string): string {
  if (!s || s.samples < 2) return text;
  let t = text;
  if (most(s.bare)) t = t.replace(/[.!?]+$/, "");
  if (most(s.lowercase)) t = t.toLowerCase();
  if (s.exclaim >= 0.5 && !t.includes("!")) t = t.replace(/[.?]*$/, "!");
  if (s.emoji >= 0.4 && s.emojis[0] && !/\p{Extended_Pictographic}/u.test(t)) t += ` ${s.emojis[0]}`;
  const cap = Math.max(3, Math.round(s.avgWords * 1.6));
  const ws = words(t);
  if (ws.length > cap) t = ws.slice(0, cap).join(" ");
  return t;
}
