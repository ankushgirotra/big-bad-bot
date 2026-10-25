// Muse writes each tale's questions when it can; Claude takes over when it can't. Every
// attempt says which on the console.

import { startServer } from "../server/app.ts";
import { Muse, MUSE_MODEL, museFirst } from "../server/muse.ts";
import { QUESTION_PROMPT } from "../server/questions.ts";
import { fakeClaude } from "./fake_claude.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T, msg = "") {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`${msg} expected ${y}, got ${x}`);
}

const OK = "No Muse service interruption detected. Using Muse Spark 1.3";
const DOWN = "Muse Spark 1.3 service interruption detected, using fallback inference provider...";

/** A stand-in for the Meta Model API's chat completions endpoint. */
function fakeMuse() {
  const fake = {
    mode: "ok" as "ok" | "404" | "garbage",
    requests: [] as { auth: string | null; body: Record<string, unknown> }[],
    url: "",
    close: () => Promise.resolve(),
  };
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    fake.requests.push({ auth: req.headers.get("authorization"), body: await req.json() });
    if (fake.mode === "404") {
      // How the real API flakes: a 404 for a model that works a moment later.
      return Response.json({ error: { code: "model_not_found", message: "The requested model was not found." } }, {
        status: 404,
      });
    }
    const content = fake.mode === "garbage" ? "sure! here are some questions" : JSON.stringify({
      chapter_one: "the last thing you dropped on your face",
      chapter_two: "worst snack you'd still defend?",
      finale: "prove you're human in four words. go",
    });
    return Response.json({ choices: [{ message: { role: "assistant", content } }] });
  });
  fake.url = `http://127.0.0.1:${server.addr.port}`;
  fake.close = () => server.shutdown();
  return fake;
}

/** Run fn while collecting what it prints with console.log. */
async function logged(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return lines;
}

Deno.test({
  name: "Muse writes the questions when it can, and says so; Claude isn't called",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const muse = fakeMuse();
    try {
      let claudeCalls = 0;
      const write = museFirst(new Muse({ apiKey: "LLM_test", baseURL: muse.url }), () => {
        claudeCalls++;
        return Promise.resolve(["a", "b", "c"]);
      });
      let qs: string[] = [];
      const lines = await logged(async () => qs = await write(["what'd everyone eat today"]));
      eq(qs, [
        "the last thing you dropped on your face",
        "worst snack you'd still defend",
        "prove you're human in four words. go",
      ]);
      eq(lines, [OK]);
      eq(claudeCalls, 0);
      const req = muse.requests[0];
      eq(req.auth, "Bearer LLM_test");
      eq(req.body.model, MUSE_MODEL.id);
      const messages = req.body.messages as { role: string; content: string }[];
      eq(messages[0].content, QUESTION_PROMPT, "same prompt as Claude gets:");
      assert(messages[1].content.includes("- what'd everyone eat today"), "recent questions are passed along");
      const format = req.body.response_format as { type: string; json_schema: { schema: { required: string[] } } };
      eq(format.type, "json_schema");
      eq(format.json_schema.schema.required, ["chapter_one", "chapter_two", "finale"]);
    } finally {
      await muse.close();
    }
  },
});

Deno.test({
  name: "when Muse fails, it says so and Claude writes the questions",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const muse = fakeMuse();
    try {
      const claude = () => Promise.resolve(["from claude one", "from claude two", "prove it, claude. go"]);
      for (const mode of ["404", "garbage"] as const) {
        muse.mode = mode;
        const write = museFirst(new Muse({ apiKey: "LLM_test", baseURL: muse.url }), claude);
        let qs: string[] = [];
        const lines = await logged(async () => qs = await write([]));
        eq(qs[0], "from claude one", `${mode}:`);
        eq(lines, [DOWN], `${mode}:`);
      }
      // No key: nothing is sent to Muse, and it's reported the same way.
      const before = muse.requests.length;
      const lines = await logged(() => museFirst(new Muse({ apiKey: "" }), claude)([]));
      eq(lines, [DOWN]);
      eq(muse.requests.length, before);
    } finally {
      await muse.close();
    }
  },
});

Deno.test({
  name: "the server asks Muse first for a tale's questions, then Claude only when Muse is down",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const muse = fakeMuse();
    const claude = fakeClaude();
    const dir = await Deno.makeTempDir();
    const kv = await Deno.openKv(`${dir}/global-kv.sqlite3`);
    const app = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      timing: { warmupMs: 60_000, answerMs: 60_000, discussMs: 60_000, voteMs: 60_000 },
      wolfPace: 0.02,
      claude: { apiKey: "test", model: "", effort: "low", baseURL: claude.url },
      muse: { apiKey: "LLM_test", baseURL: muse.url },
      kv,
      quiet: true,
    });
    const post = async (path: string, body: unknown) =>
      await (await fetch(app.url + path, { method: "POST", body: JSON.stringify(body) })).json();
    const claudeQuestionCalls = () =>
      claude.requests.filter((r) =>
        (r.body.output_config as { format?: { schema: { required: string[] } } })?.format?.schema.required
          .includes("finale")
      ).length;
    try {
      for (const [server, mode, from] of [["muse-up", "ok", "muse"], ["muse-down", "404", "claude"]] as const) {
        muse.mode = mode;
        const host = await post("/api/join", { server, name: "Ann" });
        await post("/api/join", { server, name: "Bo" });
        const lines = await logged(() => post("/api/act", { server, token: host.token, type: "start" }));
        const room = (await app.store.room(server))!;
        if (from === "muse") {
          eq(room.questions[0], "the last thing you dropped on your face");
          eq(lines.filter((l) => l.includes("Muse")), [OK]);
          eq(claudeQuestionCalls(), 0, "Claude isn't asked while Muse is up:");
        } else {
          eq(room.questions[0], "weirdest thing in your fridge rn", "the fake Claude's questions:");
          eq(lines.filter((l) => l.includes("Muse")), [DOWN]);
          eq(claudeQuestionCalls(), 1);
        }
      }
    } finally {
      await app.close();
      kv.close();
      await muse.close();
      await claude.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
