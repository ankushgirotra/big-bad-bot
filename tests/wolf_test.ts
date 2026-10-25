// WOLF_MODEL: which Claude model plays the wolf, and what each choice sends to the API.

import { configFromEnv } from "../server/app.ts";
import { Brain, WOLF_MODELS, wolfModel } from "../server/wolf.ts";
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
