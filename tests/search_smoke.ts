// `deno task test:search`: one LIVE SerpApi search through Muse's research
// layer, so you can check SERPAPI_API_KEY without playing a tale. It uses a
// throwaway in-memory cache, so it always spends one search.
//
//   deno task test:search                       # a default query
//   deno task test:search what is a chicken jockey

import { configFromEnv } from "../server/app.ts";
import { briefFrom, renderBrief, Researcher } from "../server/research.ts";

const cfg = configFromEnv().search!;
if (!cfg.apiKey) {
  console.error("SERPAPI_API_KEY is empty. Put it in .env first.");
  Deno.exit(1);
}
const kv = await Deno.openKv(":memory:");
const researcher = new Researcher(kv, { ...cfg, enabled: true });
const query = Deno.args.join(" ") || "what is a chicken jockey minecraft";
const result = await researcher.search(query, "smoke", () => Promise.resolve(true));
kv.close();
if (!result) Deno.exit(1);
const brief = briefFrom(`what "${query}" is about`, [result]);
console.log(`\n${brief ? renderBrief(brief) : "(no results)"}`);
