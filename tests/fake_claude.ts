// A stand-in for the Claude Messages API, so tests drive the real Anthropic SDK code path
// without spending anything. `failing` makes it answer like an overloaded API (HTTP 529).

export interface FakeClaude {
  url: string;
  failing: boolean;
  calls: number;
  /** The model each call asked for. */
  models: string[];
  /** What each call asked for: model, fallbacks, the anthropic-beta header, and the request body. */
  requests: { model: string; fallbacks?: unknown; beta: string | null; body: Record<string, unknown> }[];
  /** What a request for a tale's questions gets back. */
  questions: Record<string, string>;
  close(): Promise<void>;
}

export function fakeClaude(): FakeClaude {
  const fake = {
    failing: false,
    calls: 0,
    models: [],
    requests: [],
    questions: {
      chapter_one: "weirdest thing in your fridge rn?",
      chapter_two: "last thing you bought and instantly regretted",
      finale: "prove you're human using only a smell. go",
    },
  } as unknown as FakeClaude;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    fake.calls++;
    const body = await req.json();
    fake.models.push(body.model);
    fake.requests.push({ model: body.model, fallbacks: body.fallbacks, beta: req.headers.get("anthropic-beta"), body });
    if (fake.failing) {
      return Response.json(
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
        // retry-after-ms keeps the SDK's one retry quick.
        { status: 529, headers: { "retry-after-ms": "1" } },
      );
    }
    const system: string = body.system;
    const user: string = body.messages[0].content;
    // Questions come back as the structured output asked for; a vote names the first other
    // seat from the system prompt; anything else is a plain line.
    const text = body.output_config?.format
      ? JSON.stringify(fake.questions)
      : user.includes("Voting time")
      ? /The other seats: ([^ (]+)/.exec(system)![1]
      : "ok fair mine was kinda boring too";
    return Response.json({
      id: `msg_fake_${fake.calls}`,
      type: "message",
      role: "assistant",
      model: body.model,
      // Haiku 5.5 thinks first, so real replies can open with a thinking block.
      content: [{ type: "thinking", thinking: "", signature: "fake" }, { type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });
  fake.url = `http://127.0.0.1:${server.addr.port}`;
  fake.close = () => server.shutdown();
  return fake;
}
