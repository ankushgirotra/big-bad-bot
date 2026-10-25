// Every API key the app uses. They're committed on purpose: deploy the repo and it just
// works, with no environment variables or Deno Deploy secrets to set. Anyone who can read
// this repository can spend on these keys, so keep it private.

export const KEYS = {
  /** Anthropic API key for the wolf (Claude Haiku), from platform.claude.com. Billed to its account. */
  anthropic: "",
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
