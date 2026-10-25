// Every API key the app uses. They're committed on purpose: deploy the repo and it just
// works, with no environment variables or Deno Deploy secrets to set. Anyone who can read
// this repository can spend on these keys, so keep it private.

export const KEYS = {
  /** Anthropic API key for the wolf (Claude, model set by WOLF_MODEL), from platform.claude.com. */
  anthropic:
    "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",
  /** SerpApi, from serpapi.com. Nothing calls it yet. */
  serpapi: "435cfa1f2e2084bb5eb777ee1eb01caf9358b2407a2fdef9d352940657eb7e59",
  /**
   * The shared "global-kv" database on Deno Deploy (Databases > global-kv), and an access token
   * (Account settings > Access tokens). Filled in, every run uses global-kv over KV Connect, on
   * Deno Deploy and locally alike. Left empty: Deno Deploy uses the database assigned to the
   * app, and local runs use .data/global-kv.sqlite3.
   */
  denoKvDatabaseId: "",
  denoKvAccessToken: "",
};
