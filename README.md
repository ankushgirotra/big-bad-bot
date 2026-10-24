# Big Bad Bot

_who's in grandma's clothes?_

A party game for a group chat. Every player hides behind a storybook disguise ("Dev, the woodcutter", "maya, the baker's
girl"…) and writes in that disguise's voice. One extra seat is the wolf: a **Muse Spark** agent that reads every message
and tries to pass as one of the friends. Answer three questions, question anyone who seems off, then vote. Catch the
wolf and it's _Happily Ever After_; name a friend and it's _The End_.

## How a tale goes

1. **The front page** (`/`): pick a server name and your name. Friends who type the same server name land in the same
   tale. Open servers are listed.
2. **The game** (`/game?server=…`): the first player in is the host. Once at least two friends are at the cottage, the
   host leads the way into the woods.
3. **Three chapters.** Everyone answers the chapter's question (60s). Then the group talks it over (75s): tap _question
   …_ to call someone out by name. _Onward_ moves to the next chapter; the host moves it at once, anyone else needs a
   majority. _Name the wolf early_ skips ahead to the vote the same way.
4. **The vote** (45s). The wolf only loses if it gets strictly the most votes. A tie lets it slip away.
5. **The reveal** shows the real names, the votes, and what gave the wolf away (answer speed, message length, how often
   it was called out). _Read it again_ starts a new tale with a new wolf.

Up to 7 friends play at once (8 disguises, one of them the wolf's). Refreshing or reopening the page puts you back in
your seat.

## Run it

You need [Deno](https://deno.com) 2.x and a `.env`:

```bash
cp .env.example .env   # then put your MUSE_API_KEY in it
```

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

| Task                  | What it does                                               |
| --------------------- | ---------------------------------------------------------- |
| `deno task dev`       | Run with reload on save                                    |
| `deno task start`     | Run                                                        |
| `deno task test`      | Rule unit tests, plus a whole tale over HTTP + SSE         |
| `deno task test:muse` | Ask the real Muse Spark wolf for a few lines (needs a key) |
| `deno task check`     | Type-check, lint, format check                             |

## The wolf

`MUSE_API_KEY` (from [dev.meta.ai](https://dev.meta.ai)) turns on the Muse Spark wolf. It talks to the Meta Model API's
OpenAI-compatible chat completions endpoint, using `muse-spark-1.3` with `reasoning_effort: low` (about 2–3s a line). It
never uses the `-contributor` models, which let Meta train on the chat. Without a key, or if a call fails, the wolf
falls back to the scripted lines from the original design.

The wolf waits and types like a person: it answers mid-pack, replies when someone names it, sometimes jumps into the
discussion, and votes with the crowd. `WOLF_PACE=0.2` speeds it up for testing.

## Data: the shared `global-kv`

All state lives in Deno KV. The `global-kv` database is shared with other projects, so every key this app writes starts
with `["big-bad-bot"]`, and everything expires after 6 hours. The database is picked like this:

| Where it runs                                                | What it opens                                |
| ------------------------------------------------------------ | -------------------------------------------- |
| Deno Deploy                                                  | the `global-kv` database assigned to the app |
| locally, with `DENO_KV_DATABASE_ID` + `DENO_KV_ACCESS_TOKEN` | `global-kv` on Deno Deploy, over KV Connect  |
| locally, otherwise                                           | `.data/global-kv.sqlite3`                    |
| `KV_PATH` set                                                | exactly that path or URL                     |

Realtime: each player's browser holds a Server-Sent Events stream. Every change rewrites the room's pulse key, and
`kv.watch` on that key pushes the player's view to them. This works across Deploy isolates, because they all watch the
same key.

### Deploying to Deno Deploy

Make an app with `main.ts` (in this folder) as the entrypoint, assign the `global-kv` database to it (Databases →
Assign), and set `MUSE_API_KEY` in the app's environment variables. Deno Deploy keeps a separate copy of the database
for each timeline (production, each branch), so preview deployments don't touch production games.

## Layout

```
main.ts            entrypoint
server/game.ts     the rules, as pure functions (start, say, proceed, castVote, tick, …)
server/store.ts    rooms, messages, presence and typing in KV, under ["big-bad-bot"]
server/wolf.ts     the Muse Spark brain, and the driver that decides when it speaks
server/app.ts      HTTP routes and the SSE stream
server/kv.ts       opens global-kv
server/cast.ts     disguises, questions, scripted wolf lines
public/            the two pages (index.html, game.html) and the storybook styles
tests/             unit + end-to-end tests
```
