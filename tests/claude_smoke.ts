// `deno task test:claude`: asks the real Claude wolf for a few lines, so you can check the
// key, the model and the voice without playing a whole tale. Set WOLF_MODEL to try sonnet or
// opus. Spends a few cents at most.

import { castOf, type Msg, newPlayer, newRoom, start } from "../server/game.ts";
import { configFromEnv } from "../server/app.ts";
import { Brain } from "../server/wolf.ts";

const cfg = configFromEnv();
const brain = new Brain(cfg.claude);
if (brain.problem) {
  console.error(brain.problem);
  Deno.exit(1);
}

const players = ["a", "b", "c"].map((n) => newPlayer(n, 0));
const room = newRoom("smoke", players[0], 0);
room.players = players;
start(room, true, Date.now(), cfg.timing);
const humans = room.seats.map((_, i) => i).filter((i) => i !== room.wolfSeat);
const msgs: Msg[] = [
  { id: "1", kind: "chap", label: "Chapter the First", text: room.questions[0], at: 0, chapter: 0 },
  { id: "2", kind: "answer", seat: humans[0], text: "honestly nothing yet lol", at: 0, chapter: 0 },
  { id: "3", kind: "answer", seat: humans[1], text: "a gas station burrito i regret", at: 0, chapter: 0 },
];
const me = castOf(room, room.wolfSeat);
console.log(`${brain.label}, the wolf is ${me.name} (${me.voice})\n`);

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
