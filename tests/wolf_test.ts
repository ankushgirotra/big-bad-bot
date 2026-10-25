// WOLF_MODEL: which Claude model plays the wolf, and what each choice sends to the API.

import { configFromEnv } from "../server/app.ts";
import { Brain, lineProblem, QUESTION_TIMEOUT_MS, WOLF_MODELS, wolfModel } from "../server/wolf.ts";
import { fakeClaude } from "./fake_claude.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T, msg = "") {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`${msg} expected ${y}, got ${x}`);
}

Deno.test("WOLF_MODEL picks haiku, sonnet or opus, and haiku when it's unset", () => {
  eq(wolfModel(undefined), "haiku");
  eq(wolfModel(""), "haiku");
  eq(wolfModel(" Opus "), "opus");
  eq(wolfModel("SONNET"), "sonnet");
  eq(wolfModel("gpt-5"), null);
  eq(wolfModel("claude-opus-5-5"), null, "names only, not model ids");
  eq(wolfModel("toString"), null, "only the three names");
  const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });
  eq(configFromEnv(env({})).claude.model, "");
  eq(configFromEnv(env({ WOLF_MODEL: "opus" })).claude.model, "opus");
});

Deno.test("an unknown WOLF_MODEL stops the wolf with a reason players can read", () => {
  const brain = new Brain({ apiKey: "test", model: "gpt-5", effort: "low" });
  eq(brain.problem, 'WOLF_MODEL is "gpt-5": set it to haiku, sonnet or opus.');
  eq(brain.model, WOLF_MODELS.haiku.id, "nothing pricier is ever called by mistake");
});

Deno.test({
  name: "each WOLF_MODEL calls its model; sonnet and opus ask for the default fallback, haiku doesn't",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = fakeClaude();
    try {
      for (
        const [name, id, fallback] of [
          ["", "claude-haiku-5-5", false],
          ["haiku", "claude-haiku-5-5", false],
          ["sonnet", "claude-sonnet-5-5", true],
          ["opus", "claude-opus-5-5", true],
        ] as const
      ) {
        const brain = new Brain({ apiKey: "test", model: name, effort: "low", baseURL: fake.url });
        assert(brain.problem === null, `${name}: ${brain.problem}`);
        eq(await brain.complete("system", "say something"), "ok fair mine was kinda boring too");
        const req = fake.requests.at(-1)!;
        eq(req.model, id, `${name || "(unset)"}:`);
        eq(req.fallbacks, fallback ? "default" : undefined, `${name || "(unset)"} fallbacks:`);
        eq(req.beta?.includes("server-side-fallback-2026-07-01") ?? false, fallback, `${name || "(unset)"} beta:`);
      }
    } finally {
      await fake.close();
    }
  },
});

Deno.test({
  name: "questions: the WOLF_MODEL model writes three as structured output, told what to avoid",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = fakeClaude();
    try {
      const brain = new Brain({ apiKey: "test", model: "sonnet", effort: "low", baseURL: fake.url });
      const qs = await brain.questions(["what'd everyone eat today"]);
      eq(qs, [
        "weirdest thing in your fridge rn",
        "last thing you bought and instantly regretted",
        "prove you're human using only a smell. go",
      ]);
      const req = fake.requests.at(-1)!;
      eq(req.model, "claude-sonnet-5-5");
      const cfg = req.body.output_config as {
        effort: string;
        format: { type: string; schema: { required: string[] } };
      };
      eq(cfg.effort, "medium", "questions get more effort than chat lines:");
      eq(cfg.format.type, "json_schema");
      eq(cfg.format.schema.required, ["chapter_one", "chapter_two", "finale"]);
      const user = (req.body.messages as { content: string }[])[0].content;
      assert(user.includes("- what'd everyone eat today"), "the recent questions are passed along");
      assert(String(req.body.system).includes("prove you're human. go."), "the originals are the style guide");

      fake.questions = { chapter_one: "ok", chapter_two: "fine", finale: "" };
      const err = await brain.questions([]).then(() => null, (e) => e);
      assert(String(err?.message).includes("incomplete"), String(err));
      assert(QUESTION_TIMEOUT_MS <= 15_000, "the host isn't kept waiting long");
    } finally {
      await fake.close();
    }
  },
});

Deno.test("lineProblem: the word limit and the no-reasoning rule apply to the message alone", () => {
  eq(lineProblem("lol a bozo with free weekends tho", 20), null);
  eq(lineProblem("love you <3 >.<", 20), null, "hearts and faces aren't markup");
  assert(lineProblem("<thinking_mode> </thinking_mode> lol a bozo with free weekends tho", 20)?.includes("markup"));
  assert(lineProblem("<thinking_mode> The player just complimented me", 20)?.includes("markup"));
  eq(lineProblem(Array(21).fill("word").join(" "), 20), "it was 21 words, over the 20-word limit");
  eq(lineProblem("", 20), "it was empty");
});

Deno.test({
  name: "a leaked or too-long line is never sent: one retry, told why, then the move fails",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = fakeClaude();
    const room = {
      warmup: { p: [{ from: "wolf", text: "hey", at: 0 }, { from: "you", text: "I luv ur response btw", at: 0 }] },
    } as unknown as Parameters<Brain["warmLine"]>[0];
    try {
      const brain = new Brain({ apiKey: "test", model: "haiku", effort: "medium", baseURL: fake.url });
      // The screenshots: reasoning in made-up tags. The retry's clean line is what goes out.
      fake.lines = [
        "<thinking_mode> The player just complimented me, so this one needs a different opener, shorter",
        "lol a bozo with free weekends tho",
      ];
      eq(await brain.warmLine(room, "p"), "lol a bozo with free weekends tho");
      const [first, retry] = fake.requests.slice(-2);
      const format = (first.body.output_config as { format: { schema: { required: string[] } } }).format;
      eq(format.schema.required, ["message"], "lines are structured output:");
      const asked = (retry.body.messages as { content: string }[])[0].content;
      assert(asked.includes("couldn't be sent because it had markup"), asked);

      // Over the word limit twice: nothing is sent, and the error says why.
      const long = Array(26).fill("word").join(" ");
      fake.lines = [long, long];
      const err = await brain.warmLine(room, "p").then(() => null, (e) => e);
      assert(String(err?.message).includes("26 words, over the 20-word limit"), String(err));
    } finally {
      await fake.close();
    }
  },
});
