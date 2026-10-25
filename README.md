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

| Task                    | What it does                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `deno task dev`         | Run with reload on save                                                                    |
| `deno task start`       | Run                                                                                        |
| `deno task test`        | Rule unit tests, plus a whole tale over HTTP + SSE                                         |
| `deno task test:claude` | Ask the real Claude wolf (`WOLF_MODEL`'s pick) for a few lines; spends a few cents at most |
| `deno task check`       | Type-check, lint, format check                                                             |

## The wolf

The wolf is Claude, through the official Anthropic SDK (`npm:@anthropic-ai/sdk`) with `effort: low`. The `WOLF_MODEL`
environment variable picks the model:

| `WOLF_MODEL`      | Model               | Price per million tokens (in / out) | Gives up on a move after |
| ----------------- | ------------------- | ----------------------------------- | ------------------------ |
| unset, or `haiku` | `claude-haiku-5-5`  | $0.10 / $0.50                       | 15s                      |
| `sonnet`          | `claude-sonnet-5-5` | $2 / $10                            | 20s                      |
| `opus`            | `claude-opus-5-5`   | $4 / $20                            | 25s                      |

The key bills a personal account, so Haiku is the default, and Sonnet and Opus run only when you ask for them. Case and
spaces don't matter; any other value stops the wolf with a red error on both pages rather than quietly picking a model.
Sonnet and Opus can decline a request at their safety checks, so their requests opt into `fallbacks: "default"`, which
reruns a declined line on the model Anthropic recommends for that kind of decline. Haiku has no such fallback.

Set it like any other environment variable:

```bash
WOLF_MODEL=opus deno task dev
./run_podman_container.sh bash -c 'cd big-bad-bot && WOLF_MODEL=sonnet deno task dev'
```

On Deno Deploy, add `WOLF_MODEL` under the app's Settings → Environment variables (leaving it out means Haiku).
`/api/health` and the startup log show which model is playing.

The key is `KEYS.anthropic` in `server/keys.ts`; environment variables such as `ANTHROPIC_API_KEY` are deliberately
ignored, so a key in someone's shell never bills a different account.

There are no canned lines to fall back on. Without a key, both pages show a red error and no tale can start
(`/api/health` answers 503). If a call fails (after the SDK's one retry for 429/5xx/dropped connections, or after the
time above with no answer), the wolf makes no move, and every player sees a red banner with the reason until the wolf's
next move goes through.

The wolf waits and types like a person: it answers mid-pack, replies when someone names it, sometimes jumps into the
discussion, and votes with the crowd. `WOLF_PACE=0.2` speeds it up for testing. `WARMUP_SECONDS` (default 120) sets the
warm-up candle.

What the wolf learns in the warm-up (`server/style.ts`) goes into its system prompt as measured habits plus a few of the
players' real lines. If Claude can't answer in someone's warm-up chat, every player sees the error and the wolf retries
on its own a few seconds later.

## The questions

When the host leads the way into the woods, a model writes that tale's three questions: two everyday warm-ups ("name the
cursed item in your junk drawer") and a finale that dares everyone to prove they're human with a twist ("prove you're
human without typing the letter e. go"). The prompt in `server/questions.ts` hands it the original list in
`server/cast.ts` as the style guide, and the questions come back as structured output (exactly three, in chapter order).

Who writes them, in order:

1. **Meta's Muse** (`muse-spark-1.3`, key `KEYS.muse` in `server/keys.ts`), through the Meta Model API's
   OpenAI-compatible chat endpoint at minimal reasoning: about 1.5–2s. This is the only part of the game that uses Muse.
2. **Claude**, the model `WOLF_MODEL` picks, if Muse fails in any way (an error, no key, bad JSON, or no answer within
   8s): about 4–6s on Haiku, with up to 12s.
3. **The fixed list**, if Claude fails too (skipping questions this server has had).

Every Muse attempt prints one line to the server's console:

```
No Muse service interruption detected. Using Muse Spark 1.3
Muse Spark 1.3 service interruption detected, using fallback inference provider...
```

Each server remembers its last 30 questions, and the model is told not to repeat or echo them, so a group playing tale
after tale keeps getting new ones. The host's button reads _Writing the path…_ while they're written. No call is made
unless the tale can actually start.

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
server/questions.ts the prompt and check for each tale's questions
server/muse.ts     Meta's Muse, tried first for the questions
server/keys.ts     every API key, committed on purpose
server/cast.ts     disguises and questions
public/            the two pages (index.html, game.html) and the storybook styles
tests/             unit + end-to-end tests
```
