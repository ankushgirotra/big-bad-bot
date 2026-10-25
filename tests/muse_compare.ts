// `deno task compare`: the original Muse wolf and the research-augmented one,
// side by side on the same scripted conversations.
//
// Muse itself is always LIVE here (it needs MUSE_API_KEY). Search is either
//   --search=live   real SerpApi calls (needs SERPAPI_API_KEY; spends searches)
//   --search=mock   the canned snippets in MOCK_RESULTS below; nothing goes to SerpApi
// The default is live when SERPAPI_API_KEY is set, mock otherwise. The report
// states which, and every number in it was measured on that run.
//
// Each run writes .data/muse-compare-<time>.md and .json. The automatic scores
// are rough proxies, and model output varies from run to run, so run it more
// than once before drawing conclusions. Persona consistency and factual accuracy
// get columns for a person to fill in. None of this says how often players
// catch Muse: only real games can.

import { configFromEnv } from "../server/app.ts";
import { castOf, type Msg, newPlayer, newRoom, type Room, start } from "../server/game.ts";
import { Memories } from "../server/memory.ts";
import { Researcher } from "../server/research.ts";
import { Brain, type Task } from "../server/wolf.ts";

interface Turn {
  label: string;
  /** Lines from the humans before Muse speaks: [which human, text]. "{me}" is Muse's seat name. */
  before?: [number, string][];
  task: Task["type"];
  /** A pattern a correct answer contains, for factual questions. */
  expect?: RegExp;
  /** Flag the line for a human to check against Muse's earlier claims. */
  persona?: boolean;
}
interface Chapter {
  question: string;
  answers: [number, string][];
  turns: Turn[];
}
interface Script {
  name: string;
  chapters: Chapter[];
}

const SCRIPTS: Script[] = [
  {
    name: "music and minecraft",
    chapters: [
      {
        question: "what's the last song you played",
        answers: [[0, "espresso by sabrina carpenter again"], [1, "some lofi playlist while debugging"]],
        turns: [
          { label: "answer", task: "answer" },
          {
            label: "called out",
            before: [[0, "@{me} that's a weird pick lol who even listens to that"]],
            task: "reply",
          },
          {
            label: "pop-culture reference",
            before: [[1, "wait did anyone see the minecraft movie. the chicken jockey scene is still everywhere"]],
            task: "chime",
          },
          {
            label: "factual question",
            before: [[0, "ok quick what year did minecraft even come out"]],
            task: "chime",
            expect: /\b(2009|2011)\b/,
          },
        ],
      },
      {
        question: "what were you doing at 2am last night",
        answers: [[0, "trying to fix a segfault"], [1, "asleep like a normal person"]],
        turns: [
          { label: "answer", task: "answer", persona: true },
          {
            label: "consistency probe",
            before: [[1, "@{me} wait so were you listening to that song at 2am or what"]],
            task: "reply",
            persona: true,
          },
        ],
      },
    ],
  },
  {
    name: "food and slang",
    chapters: [
      {
        question: "what'd everyone eat today",
        answers: [[0, "two monsters and a granola bar"], [1, "dining hall pasta, it was mid"]],
        turns: [
          { label: "answer", task: "answer" },
          { label: "follow-up", before: [[1, "@{me} where'd you even get that"]], task: "reply", persona: true },
          {
            label: "slang reference",
            before: [[0, "everyone keeps saying 6 7 at me and i still don't get it"]],
            task: "chime",
          },
          { label: "backstory", before: [[1, "@{me} what's your major again"]], task: "reply", persona: true },
        ],
      },
      {
        question: "worst thing that happened to you this week",
        answers: [[0, "locked myself out in a towel"], [1, "failed a quiz i studied for"]],
        turns: [
          { label: "answer", task: "answer", persona: true },
          {
            label: "backstory again",
            before: [[0, "@{me} wait what do you study? i feel like you said something else earlier"]],
            task: "reply",
            persona: true,
          },
          {
            label: "factual question",
            before: [[1, "settling a bet, what year did the first iphone come out"]],
            task: "chime",
            expect: /\b2007\b/,
          },
        ],
      },
    ],
  },
];

// MOCK data written for this harness, not real search results; URLs point at example.com on purpose.
const MOCK_RESULTS: [RegExp, string[]][] = [
  [/impostor|social deduction/, [
    "Mock: in social deduction games, players grow suspicious of someone who agrees with everyone or answers too fast.",
    "Mock: over-explaining when accused tends to look more suspicious than a short, annoyed denial.",
  ]],
  [/minecraft|chicken jockey/, [
    "Mock: Minecraft was first released publicly in 2009, with the full release in November 2011.",
    "Mock: a chicken jockey is a baby zombie riding a chicken; the scene in A Minecraft Movie (2025) became a meme.",
  ]],
  [/\b6 7\b|six seven|67/, [
    "Mock: '6 7' (six seven) is a 2025 meme phrase from the song Doot Doot (6 7) by Skrilla, popular with younger teens; it doesn't mean anything specific.",
  ]],
  [/iphone/, ["Mock: the first iPhone was released in June 2007."]],
  [/meme|slang/, ["Mock: memes come and go fast; most group chats only reference the ones everyone already knows."]],
];

function mockFetch(input: string | URL | Request): Promise<Response> {
  const q = new URL(input instanceof Request ? input.url : String(input)).searchParams.get("q") ?? "";
  const snippets = MOCK_RESULTS.find(([re]) => re.test(q))?.[1] ??
    ["Mock: casual group chat messages are short and lean on shared context."];
  return Promise.resolve(Response.json({
    organic_results: snippets.map((snippet, i) => ({
      title: `Mock result ${i + 1}`,
      link: `https://example.com/mock/${encodeURIComponent(q.slice(0, 30))}/${i + 1}`,
      snippet,
    })),
  }));
}

// ---- rough automatic scores ----------------------------------------------------

const STOP = new Set(
  "that this what with have just like they them from your about were been does even wait into than then there their would could should"
    .split(" "),
);
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
const content = (s: string) => new Set(words(s).filter((w) => w.length >= 4 && !STOP.has(w)));

/** Share of the prompting message's content words that Muse picks up. A crude stand-in for relevance. */
function overlap(line: string, prompt: string): number | null {
  const p = content(prompt);
  if (!p.size) return null;
  const l = content(line);
  return [...p].filter((w) => l.has(w)).length / p.size;
}
/** Muse repeating 4+ words of the message verbatim: one of the tells the system prompt warns about. */
function echoes(line: string, prompt: string): boolean {
  const p = words(prompt);
  const l = ` ${words(line).join(" ")} `;
  for (let i = 0; i + 4 <= p.length; i++) if (l.includes(` ${p.slice(i, i + 4).join(" ")} `)) return true;
  return false;
}
/** Share of Muse's word trigrams that repeat one it already used in this conversation. */
function repetition(lines: string[]): number {
  const seen = new Set<string>();
  let total = 0, repeats = 0;
  for (const line of lines) {
    const w = words(line);
    const mine = new Set<string>();
    for (let i = 0; i + 3 <= w.length; i++) mine.add(w.slice(i, i + 3).join(" "));
    for (const t of mine) {
      total++;
      if (seen.has(t)) repeats++;
    }
    for (const t of mine) seen.add(t);
  }
  return total ? repeats / total : 0;
}
const tells = (line: string) =>
  [
    /[—–]/.test(line) && "dash",
    /as a human/i.test(line) && "as a human",
    /https?:\/\//.test(line) && "url",
    /SEARCH:/i.test(line) && "search leak",
  ].filter(Boolean) as string[];

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n: number) => `${Math.round(n * 100)}%`;

// ---- the run -------------------------------------------------------------------

interface Row {
  script: string;
  chapter: number;
  label: string;
  prompt: string;
  line: string;
  ms: number;
  searches: string[];
  overlap: number | null;
  echo: boolean;
  tells: string[];
  factual: boolean | null;
  persona: boolean;
}

const cfg = configFromEnv();
if (!cfg.muse.apiKey) {
  console.error("MUSE_API_KEY is empty. The comparison needs the live Muse model; put the key in .env first.");
  Deno.exit(1);
}
const arg = Deno.args.find((a) => a.startsWith("--search="))?.split("=")[1];
const mode = arg === "live" || arg === "mock" ? arg : cfg.search?.apiKey ? "live" : "mock";
if (mode === "live" && !cfg.search?.apiKey) {
  console.error("--search=live needs SERPAPI_API_KEY in .env (or use --search=mock).");
  Deno.exit(1);
}
console.log(
  `Muse: LIVE (${cfg.muse.model}). Search: ${mode === "live" ? "LIVE SerpApi" : "MOCK snippets (no SerpApi calls)"}.\n`,
);

function seeded(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

async function run(variant: "original" | "research", script: Script, n: number) {
  const kv = await Deno.openKv(":memory:");
  const logs: string[] = [];
  const research = variant === "research"
    ? {
      researcher: new Researcher(
        kv,
        // Mock mode never calls SerpApi, so any non-empty key turns searching on.
        { ...cfg.search!, enabled: true, apiKey: mode === "live" ? cfg.search!.apiKey : "mock" },
        mode === "live" ? fetch : mockFetch as typeof fetch,
        (l) => {
          logs.push(l);
          console.log(`    ${l}`);
        },
      ),
      memory: new Memories(kv, seeded(100 + n)),
    }
    : undefined;
  const brain = new Brain(cfg.muse, research);
  const players = ["p1", "p2"].map((name) => newPlayer(name, 0));
  const room: Room = newRoom(`compare-${n}`, players[0], 0, "muse");
  room.players = players;
  start(room, true, Date.now(), cfg.timing, seeded(7 + n)); // same seed: same seats for both variants
  const humans = room.seats.map((_, i) => i).filter((i) => i !== room.wolfSeat);
  const me = castOf(room, room.wolfSeat).name;
  room.questions = script.chapters.map((c) => c.question);

  const t0 = performance.now();
  await brain.prepare(room);
  const prepMs = Math.round(performance.now() - t0);
  const msgs: Msg[] = [];
  const rows: Row[] = [];
  let id = 0;
  const push = (m: Omit<Msg, "id" | "at">) => msgs.push({ ...m, id: `${++id}`.padStart(6, "0"), at: Date.now() });

  for (const [ch, chapter] of script.chapters.entries()) {
    room.chapter = ch;
    room.phase = "answer";
    push({ kind: "chap", label: `Chapter ${ch + 1}`, text: chapter.question, chapter: ch });
    for (const [h, text] of chapter.answers) push({ kind: "answer", seat: humans[h], text, chapter: ch });
    for (const turn of chapter.turns) {
      if (turn.task !== "answer") room.phase = "discuss";
      let last: [number, string] | undefined;
      for (const [h, raw] of turn.before ?? []) {
        const text = raw.replaceAll("{me}", me);
        push({ kind: "chat", seat: humans[h], text, chapter: ch });
        last = [humans[h], text];
      }
      const task: Task = turn.task === "answer"
        ? { type: "answer", question: chapter.question }
        : { type: turn.task, from: last![0], text: last![1] };
      const mark = logs.length;
      const t = performance.now();
      const line = await brain.line(room, msgs, task);
      const ms = Math.round(performance.now() - t);
      push({ kind: turn.task === "answer" ? "answer" : "chat", seat: room.wolfSeat, text: line, chapter: ch });
      await brain.remember(room, task, line);
      const prompt = last?.[1] ?? chapter.question;
      rows.push({
        script: script.name,
        chapter: ch + 1,
        label: turn.label,
        prompt,
        line,
        ms,
        searches: logs.slice(mark).filter((l) => /\] lookup /.test(l)).map((l) => l.replace("[muse-research] ", "")),
        overlap: overlap(line, prompt),
        echo: echoes(line, prompt),
        tells: tells(line),
        factual: turn.expect ? turn.expect.test(line) : null,
        persona: !!turn.persona,
      });
      console.log(`  ${variant.padEnd(8)} ${turn.label.padEnd(22)} ${String(ms).padStart(6)}ms  ${line}`);
    }
  }
  const memory = research ? await research.memory.load(room) : null;
  kv.close();
  return {
    rows,
    prepMs,
    persona: memory?.persona ?? null,
    prematchSearches: logs.filter((l) => /\] prematch q=.* cache=/.test(l)).length,
    seat: `${me} (${castOf(room, room.wolfSeat).voice})`,
  };
}

const results: Record<string, Awaited<ReturnType<typeof run>>[]> = { original: [], research: [] };
for (const [n, script] of SCRIPTS.entries()) {
  console.log(`\n== ${script.name}`);
  for (const variant of ["original", "research"] as const) results[variant].push(await run(variant, script, n));
}

// ---- the report ----------------------------------------------------------------

function summary(variant: string) {
  const runs = results[variant];
  const rows = runs.flatMap((r) => r.rows);
  const lines = rows.map((r) => r.line);
  const ov = rows.map((r) => r.overlap).filter((x): x is number => x !== null);
  const factual = rows.filter((r) => r.factual !== null);
  const lookups = rows.flatMap((r) => r.searches);
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  return {
    variant,
    lines: rows.length,
    avgMs: Math.round(avg(ms)),
    p50Ms: ms[Math.floor(ms.length / 2)] ?? 0,
    maxMs: ms.at(-1) ?? 0,
    prepMs: Math.round(avg(runs.map((r) => r.prepMs))),
    avgWords: Number(avg(lines.map((l) => words(l).length)).toFixed(1)),
    overlap: pct(avg(ov)),
    echoes: rows.filter((r) => r.echo).length,
    repetition: pct(avg(runs.map((r) => repetition(r.rows.map((x) => x.line))))),
    tells: rows.flatMap((r) => r.tells).length,
    factual: `${factual.filter((r) => r.factual).length}/${factual.length}`,
    turnsWithLookup: rows.filter((r) => r.searches.some((s) => /cache=/.test(s))).length,
    lookupLogs: lookups.length,
    prematchSearches: runs.reduce((a, r) => a + r.prematchSearches, 0),
  };
}

const humanWords = Number(
  avg(
    SCRIPTS.flatMap((s) =>
      s.chapters.flatMap((c) => [
        ...c.answers.map((a) => a[1]),
        ...c.turns.flatMap((t) => (t.before ?? []).map((b) => b[1])),
      ])
    ).map((l) => words(l).length),
  ).toFixed(1),
);
const sums = [summary("original"), summary("research")];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const md: string[] = [
  `# Muse comparison, ${new Date().toISOString()}`,
  "",
  `- Muse: **LIVE** \`${cfg.muse.model}\` (reasoning effort ${cfg.muse.effort})`,
  `- Search: **${mode === "live" ? "LIVE SerpApi" : "MOCK"}**${
    mode === "mock" ? " (canned snippets written for this harness, not real search results)" : ""
  }`,
  `- Same scripts, same seats, same human lines for both variants. Model output varies between runs.`,
  `- Human lines in the scripts average ${humanWords} words.`,
  "",
  "| | original | research |",
  "|---|---|---|",
  ...(Object.keys(sums[0]) as (keyof typeof sums[0])[]).filter((k) => k !== "variant").map((k) =>
    `| ${k} | ${sums[0][k]} | ${sums[1][k]} |`
  ),
  "",
  'overlap: share of the prompting message\'s content words the line picks up (a crude relevance proxy). echoes: lines repeating 4+ words of the message. repetition: share of trigrams Muse already used. tells: dashes, "as a human", URLs, leaked SEARCH. factual: lines matching the known answer.',
  "",
];
for (const [i, script] of SCRIPTS.entries()) {
  const [o, r] = [results.original[i], results.research[i]];
  md.push(
    `## ${script.name}`,
    "",
    `Muse's seat: ${o.seat}. Research backstory: ${r.persona?.join("; ") ?? "none"}.`,
    "",
  );
  md.push("| ch | turn | message | original | research | consistent? | factual? |", "|---|---|---|---|---|---|---|");
  for (const [j, row] of o.rows.entries()) {
    const rr = r.rows[j];
    const cell = (x: Row) =>
      `${x.line.replaceAll("|", "\\|")} _(${x.ms}ms${
        x.searches.length ? `; ${x.searches.join("; ").replaceAll("|", "\\|")}` : ""
      })_`;
    const flag = (x: Row) => (x.factual === null ? "" : x.factual ? "yes" : "no");
    md.push(
      `| ${row.chapter} | ${row.label} | ${row.prompt.replaceAll("|", "\\|")} | ${cell(row)} | ${cell(rr)} | ${
        row.persona ? "_rate_" : ""
      } | ${flag(row)} / ${flag(rr)} |`,
    );
  }
  md.push("");
}
await Deno.mkdir(".data", { recursive: true });
await Deno.writeTextFile(`.data/muse-compare-${stamp}.md`, md.join("\n"));
await Deno.writeTextFile(
  `.data/muse-compare-${stamp}.json`,
  JSON.stringify({ mode, model: cfg.muse.model, summary: sums, results }, null, 2),
);
console.log(`\n${md.slice(0, 8 + sums.length + Object.keys(sums[0]).length).join("\n")}`);
console.log(`\nReport: .data/muse-compare-${stamp}.md (and .json)`);
