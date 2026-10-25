// `deno task test:muse`: asks the real Muse Spark wolf for a few lines, so you
// can check the key, the model and the voice without playing a whole tale.

import { castOf, type Msg, newPlayer, newRoom, start } from "../server/game.ts";
import { configFromEnv } from "../server/app.ts";
import { Brain } from "../server/wolf.ts";

const cfg = configFromEnv();
if (!cfg.muse.apiKey) {
  console.error("MUSE_API_KEY is empty. Put it in .env first.");
  Deno.exit(1);
}
const brain = new Brain(cfg.muse);

const players = ["a", "b", "c"].map((n) => newPlayer(n, 0));
const room = newRoom("smoke", players[0], 0, "muse");
room.players = players;
start(room, true, Date.now(), cfg.timing);
const humans = room.seats.map((_, i) => i).filter((i) => i !== room.wolfSeat);
const msgs: Msg[] = [
  { id: "1", kind: "chap", label: "Chapter the First", text: room.questions[0], at: 0, chapter: 0 },
  { id: "2", kind: "answer", seat: humans[0], text: "honestly nothing yet lol", at: 0, chapter: 0 },
  { id: "3", kind: "answer", seat: humans[1], text: "a gas station burrito i regret", at: 0, chapter: 0 },
];
// Pretend the warm-up chat happened, so the wolf has a style to copy.
room.warmup[players[1].id].push(
  { from: "you", text: "lol idk man just vibing", at: 0 },
  { from: "you", text: "nah thats wild tbh", at: 0 },
);
const me = castOf(room, room.wolfSeat);
const warmT0 = performance.now();
console.log(`warm-up (${Math.round(performance.now() - warmT0)}ms): ${await brain.warmLine(room, players[1].id)}`);
console.log(`model ${cfg.muse.model} (${cfg.muse.effort}), the wolf is ${me.name} (${me.voice})\n`);

for (
  const task of [
    { type: "answer" as const, question: room.questions[0] },
    { type: "reply" as const, from: humans[0], text: `@${me.name} that answer was weird. explain` },
  ]
) {
  const t0 = performance.now();
  const line = await brain.line(room, msgs, task);
  console.log(`${task.type} (${Math.round(performance.now() - t0)}ms): ${line}`);
}
const t0 = performance.now();
const vote = await brain.vote(room, msgs);
console.log(`vote (${Math.round(performance.now() - t0)}ms): ${castOf(room, vote).name}`);
