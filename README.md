# Big Bad Bot

_who's in grandma's clothes?_

A party game for a group chat. Every player hides behind a storybook disguise ("Dev, the woodcutter", "maya, the baker's
girl"…) and writes in that disguise's voice. One extra seat is the wolf: a **Claude** agent that reads every message and
tries to pass as one of the friends. Answer three questions, question anyone who seems off, then vote. Catch the wolf
and it's _Happily Ever After_; name a friend and it's _The End_.

## How a tale goes

1. **The front page** (`/`): pick a server name and your name. Friends who type the same server name land in the same
   tale. Open servers are listed.
2. **The game** (`/game?server=…`): the first player in is the host. Once at least two friends are at the cottage, the
   host leads the way into the woods.
3. **The warm-up** (up to 2 minutes). Before the path begins, each player has a private chat with the wolf. Talk like
   you normally text (up to 5 messages; _I'm ready_ appears after 3). The wolf measures your style (casing, punctuation,
   length, slang, emoji) and writes like the group for the rest of the tale. Nobody else sees your chat.
4. **Three chapters.** Everyone answers the chapter's question (60s). Then the group talks it over (75s): tap _question
   …_ to call someone out by name. _Onward_ moves to the next chapter; the host moves it at once, anyone else needs a
   majority. _Name the wolf early_ skips ahead to the vote the same way.
5. **The vote** (45s). The wolf only loses if it gets strictly the most votes. A tie lets it slip away.
6. **The reveal** shows the real names, the votes, and what gave the wolf away (answer speed, message length, how often
   it was called out). _Read it again_ starts a new tale with a new wolf.

Up to 7 friends play at once (8 disguises, one of them the wolf's). Refreshing or reopening the page puts you back in
your seat.

## Run it

You need [Deno](https://deno.com) 2.x. Every API key is already in `server/keys.ts`, committed on purpose, so there is
no `.env` to set up.

**On a Mac:**

```bash
brew install deno
deno task dev
```

**In the team's container**, from the folder above this one:

```bash
./run_podman_container.sh bash -c 'cd big-bad-bot && deno task dev'
```

Either way, open http://localhost:8000. Friends on the same Wi-Fi can join at `http://<your-ip>:8000`.

| Task                    | What it does                                                  |
| ----------------------- | ------------------------------------------------------------- |
| `deno task dev`         | Run with reload on save                                       |
| `deno task start`       | Run                                                           |
| `deno task test`        | Rule unit tests, plus a whole tale over HTTP + SSE            |
| `deno task test:claude` | Ask the real Claude wolf for a few lines (spends a few cents) |
| `deno task check`       | Type-check, lint, format check                                |

## The wolf

The wolf is always Claude Haiku (`claude-haiku-5-5`, hardcoded in `server/wolf.ts` as `WOLF_MODEL`; nothing else is ever
called, because the key bills a personal account). It goes through the official Anthropic SDK (`npm:@anthropic-ai/sdk`)
with `effort: low`. The key is `KEYS.anthropic` in `server/keys.ts`; environment variables such as `ANTHROPIC_API_KEY`
are deliberately ignored, so a key in someone's shell never bills a different account.

There are no canned lines to fall back on. Without a key, both pages show a red error and no tale can start
(`/api/health` answers 503). If a call fails (after the SDK's one retry for 429/5xx/dropped connections, or after 15s
with no answer), the wolf makes no move, and every player sees a red banner with the reason until the wolf's next move
goes through.

The wolf waits and types like a person: it answers mid-pack, replies when someone names it, sometimes jumps into the
discussion, and votes with the crowd. `WOLF_PACE=0.2` speeds it up for testing. `WARMUP_SECONDS` (default 120) sets the
warm-up candle.

What the wolf learns in the warm-up (`server/style.ts`) goes into its system prompt as measured habits plus a few of the
players' real lines. If Claude can't answer in someone's warm-up chat, every player sees the error and the wolf retries
on its own a few seconds later.

## Data: the shared `global-kv`

All state lives in Deno KV. The `global-kv` database is shared with other projects, so every key this app writes starts
with `["big-bad-bot"]`, and everything expires after 6 hours. The database is picked like this:

| Where it runs                                                       | What it opens                                |
| ------------------------------------------------------------------- | -------------------------------------------- |
| `KV_PATH` env var set                                               | exactly that path or URL                     |
| `denoKvDatabaseId` + `denoKvAccessToken` filled in `server/keys.ts` | `global-kv` over KV Connect, from anywhere   |
| otherwise, on Deno Deploy                                           | the `global-kv` database assigned to the app |
| otherwise, locally                                                  | `.data/global-kv.sqlite3`                    |

Realtime: each player's browser holds a Server-Sent Events stream. Every change rewrites the room's pulse key, and
`kv.watch` on that key pushes the player's view to them. This works across Deploy isolates, because they all watch the
same key.

### Deploying to Deno Deploy

Make an app from this repository with `main.ts` as the entrypoint. The keys come with the code, so there are no
environment variables or secrets to set. For game state, either fill in the `global-kv` ID and token in
`server/keys.ts`, or assign the `global-kv` database to the app (Databases → Assign). An assigned database gets a
separate copy for each timeline (production, each branch), so preview deployments don't touch production games.

The keys in `server/keys.ts` are readable by anyone who can read this repository: keep it private. If it ever goes
public, GitHub's secret scanning reports the Anthropic key to Anthropic, which revokes it.

## Layout

```
main.ts            entrypoint
server/game.ts     the rules, as pure functions (start, say, proceed, castVote, tick, …)
server/store.ts    rooms, messages, presence and typing in KV, under ["big-bad-bot"]
server/wolf.ts     the Claude Haiku brain, and the driver that decides when it speaks
server/app.ts      HTTP routes and the SSE stream
server/kv.ts       opens global-kv
server/keys.ts     every API key, committed on purpose
server/cast.ts     disguises and questions
public/            the two pages (index.html, game.html) and the storybook styles
tests/             unit + end-to-end tests
```
