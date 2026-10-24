// Opens the shared "global-kv" database. Several projects share it, so every
// key Big Bad Bot reads or writes starts with NS.

export const NS = ["big-bad-bot"] as const;

/**
 * Picks the database, first match wins:
 *   KV_PATH                  any path or KV Connect URL, passed straight to Deno.openKv
 *   DENO_KV_DATABASE_ID      global-kv on Deno Deploy from outside Deploy
 *                            (also needs DENO_KV_ACCESS_TOKEN, which Deno reads itself)
 *   DENO_DEPLOY              running on Deno Deploy: the global-kv assigned to the app
 *   otherwise                a local file, .data/global-kv.sqlite3
 */
export async function openGlobalKv(env: Pick<Deno.Env, "get"> = Deno.env): Promise<{ kv: Deno.Kv; where: string }> {
  const path = env.get("KV_PATH");
  if (path) return { kv: await Deno.openKv(path), where: path };

  const id = env.get("DENO_KV_DATABASE_ID");
  if (id) {
    if (!env.get("DENO_KV_ACCESS_TOKEN")) {
      throw new Error("DENO_KV_DATABASE_ID is set, but DENO_KV_ACCESS_TOKEN is empty. Add an access token to .env.");
    }
    return {
      kv: await Deno.openKv(`https://api.deno.com/v2/databases/${id}/connect`),
      where: `global-kv on Deno Deploy (${id})`,
    };
  }

  if (env.get("DENO_DEPLOY")) return { kv: await Deno.openKv(), where: "global-kv (assigned to this Deno Deploy app)" };

  await Deno.mkdir(".data", { recursive: true });
  return { kv: await Deno.openKv(".data/global-kv.sqlite3"), where: ".data/global-kv.sqlite3 (local)" };
}
