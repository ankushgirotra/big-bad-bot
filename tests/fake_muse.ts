// A stand-in for the Meta Model API's chat completions endpoint, so tests drive the real
// Muse Spark code path. `failing` makes it answer like the real API's flaky 404.

export interface FakeMuse {
  url: string;
  failing: boolean;
  calls: number;
  close(): Promise<void>;
}

export function fakeMuse(): FakeMuse {
  const fake = { failing: false, calls: 0 } as FakeMuse;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    fake.calls++;
    const body = await req.json();
    if (fake.failing) {
      return Response.json(
        { error: { code: "model_not_found", message: "The requested model was not found." } },
        { status: 404 },
      );
    }
    const [system, user] = body.messages.map((m: { content: string }) => m.content);
    // A vote names the first other seat from the system prompt; anything else is a plain line.
    const content = user.includes("Voting time")
      ? /The other seats: ([^ (]+)/.exec(system)![1]
      : "ok fair mine was kinda boring too";
    return Response.json({ choices: [{ message: { content } }] });
  });
  fake.url = `http://127.0.0.1:${server.addr.port}`;
  fake.close = () => server.shutdown();
  return fake;
}
