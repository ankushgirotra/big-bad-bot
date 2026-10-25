// WOLF_MODEL: which Claude model plays the wolf, and what each choice sends to the API.

import { configFromEnv } from "../server/app.ts";
import { Brain, NotALineError, parseLine, WOLF_MODELS, wolfModel } from "../server/wolf.ts";
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
        eq(parseLine(await brain.complete("system", "say something")), "ok fair mine was kinda boring too");
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

Deno.test("a reply that corrects itself posts only the last tagged line", () => {
  eq(parseLine("<message>tripped over my laundry basket</message>"), "tripped over my laundry basket");
  eq(parseLine("  <message>\n  nah same\n</message>\n"), "nah same", "whitespace around it");
  eq(
    parseLine(
      "<message>lol ok mine was tripping</message> Wait, that has a lol. <message>tripped over my laundry basket</message>",
    ),
    "tripped over my laundry basket",
    "the last tag wins",
  );
  eq(parseLine("sure thing <message>fair enough</message> hope that helps"), "fair enough", "text outside is ignored");
  eq(parseLine("<message>ran out of ro"), "ran out of ro", "an unclosed tag still gives its line");
});

Deno.test("a reply without a message tag is never used, even a polite refusal", () => {
  const bads = [
    "ok fair mine was kinda boring too",
    "I'm not going to write this one. It's built to have me pass as a human to real people in a group chat.",
    "",
  ];
  for (const bad of bads) {
    let error: unknown;
    try {
      parseLine(bad);
    } catch (err) {
      error = err;
    }
    assert(error instanceof NotALineError, `used as a line: ${bad.slice(0, 40)}`);
  }
});

Deno.test("a reply about the instructions is refused, tagged or not", () => {
  // The line that really showed up in a game's chat.
  const leaked = "lol ok mine was tripping over my own laundry basket at 2am Wait, I need to correct that: the " +
    'instructions say no "lol" tacked on, and I should keep it short. Here is the corrected message: ash: tripped';
  for (const bad of [leaked, `<message>${leaked}</message>`, "<message>Here is the corrected message: nah</message>"]) {
    let message = "";
    try {
      parseLine(bad);
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message.length > 0, `not refused: ${bad.slice(0, 40)}`);
  }
  for (const fine of ["i hate instructions lol", "the teacher gave us instructions for the lab", "that's fixed now"]) {
    eq(parseLine(`<message>${fine}</message>`), fine, "an ordinary line that mentions one of those words");
  }
});

/** A Brain whose Claude calls come from a script instead of the network. */
class ScriptedBrain extends Brain {
  calls = 0;
  constructor(readonly replies: string[]) {
    super({ apiKey: "test", model: "", effort: "low" });
  }
  override complete(): Promise<string> {
    return Promise.resolve(this.replies[this.calls++] ?? "");
  }
}

Deno.test("a reply that isn't a chat line gets one more try, then an error", async () => {
  const refusal = "I'm not going to write this one. I can help in other ways.";
  const ok = new ScriptedBrain([refusal, "<message>same here tbh</message>"]);
  eq(await ok.chat("system", "user"), "same here tbh");
  eq(ok.calls, 2, "asked again once");

  const stuck = new ScriptedBrain([refusal, refusal, "<message>never reached</message>"]);
  let error: unknown;
  try {
    await stuck.chat("system", "user");
  } catch (err) {
    error = err;
  }
  assert(error instanceof NotALineError, "a second refusal surfaces as an error");
  eq(stuck.calls, 2, "no more than two tries");
});
