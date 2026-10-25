// Opens the shared "global-kv" database. Several projects share it, so every
// key Big Bad Bot reads or writes starts with NS.

import { KEYS } from "./keys.ts";

export const NS = ["big-bad-bot"] as const;

/**
 * Picks the database, first match wins:
 *   KV_PATH env var                 any path or KV Connect URL, passed straight to Deno.openKv
 *   KEYS.denoKvDatabaseId (+ token) global-kv on Deno Deploy over KV Connect, from anywhere
 *   DENO_DEPLOY                     running on Deno Deploy: the global-kv assigned to the app
 *   otherwise                       a local file, .data/global-kv.sqlite3
 */
export async function openGlobalKv(
  env: Pick<Deno.Env, "get" | "set"> = Deno.env,
  keys: Pick<typeof KEYS, "denoKvDatabaseId" | "denoKvAccessToken"> = KEYS,
): Promise<{ kv: Deno.Kv; where: string }> {
  const path = env.get("KV_PATH");
  if (path) return { kv: await Deno.openKv(path), where: path };

  const id = keys.denoKvDatabaseId.trim();
  if (id) {
    const token = keys.denoKvAccessToken.trim();
    if (!token) throw new Error("server/keys.ts has a denoKvDatabaseId but no denoKvAccessToken. Add the token.");
    // Deno's KV Connect client reads the token from this variable.
    env.set("DENO_KV_ACCESS_TOKEN", token);
    return {
      kv: await Deno.openKv(`https://api.deno.com/v2/databases/${id}/connect`),
      where: `global-kv on Deno Deploy (${id})`,
    };
  }

  if (env.get("DENO_DEPLOY")) return { kv: await Deno.openKv(), where: "global-kv (assigned to this Deno Deploy app)" };

  await Deno.mkdir(".data", { recursive: true });
  return { kv: await Deno.openKv(".data/global-kv.sqlite3"), where: ".data/global-kv.sqlite3 (local)" };
}
