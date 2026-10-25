// Each tale's three questions: the prompt, the shape they come back in, and the check they
// must pass. Muse (server/muse.ts) and Claude (server/wolf.ts) both write them from here, so
// the questions read the same whichever one answers.

import { LAST_QUESTION, QUESTION_POOL } from "./cast.ts";
import { cleanText } from "./game.ts";

export const QUESTION_PROMPT = [
  `You write the chapter questions for Big Bad Bot, a party game played in a group chat. Friends hide behind storybook names, and one extra seat is secretly an AI trying to pass as one of them. Each tale has three chapters: everyone answers the chapter's question in the chat, the group picks the answers apart, and at the end they vote on who the AI is.`,
  `So a good question is one where real people's answers come out specific, a little messy and personal, and an AI has to invent a life to keep up: what someone ate today, what's on their lock screen, the last thing they lied about. Anyone can answer it in one quick line from their own day, week or life, and the answers are fun to read side by side. Never invasive: nothing about trauma, health, money, politics, religion, sex or relationships, or anything you wouldn't ask a group of acquaintances.`,
  `Write them the way the host would text them to the group: all lowercase, short (about 3 to 9 words), no question mark, casual. Vary how they open, like the originals do, rather than starting each one with "what's". Use "rn" only when the question really is about right now.`,
  `Players can only type text: no photos, voice notes or links.`,
  `Chapters one and two are warm-ups about everyday life. The finale openly dares everyone to prove they're human, or that they're not the bot, like the original "${LAST_QUESTION}", with a fresh twist on how: a limit, a format, or a kind of proof only a person would have. It names being human (or the bot) outright and ends in ". go", for example "prove you're human in five words. go" or "convince us you're not the bot, no emojis allowed. go".`,
  `The originals, for style:\n${[...QUESTION_POOL, LAST_QUESTION].map((q) => `- ${q}`).join("\n")}`,
].join("\n\n");

/** The JSON the questions come back as: exactly three strings, in chapter order. */
export const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    chapter_one: { type: "string" },
    chapter_two: { type: "string" },
    finale: { type: "string" },
  },
  required: ["chapter_one", "chapter_two", "finale"],
  additionalProperties: false,
};

/** The request for a new tale's questions, steering clear of what this server already had. */
export function questionAsk(recent: string[]): string {
  return recent.length
    ? `Write the three questions for a new tale. Make them fresh: don't reuse the originals, and don't reuse or closely echo any question this group has already answered:\n${
      recent.map((q) => `- ${q}`).join("\n")
    }`
    : "Write the three questions for a new tale. Make them fresh: don't reuse the originals.";
}

/** The three questions from a model's JSON reply, or a readable error naming who sent it. */
export function parseQuestions(raw: string, who: string): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${who}'s questions weren't JSON: ${JSON.stringify(raw.slice(0, 80))}`);
  }
  // The originals never end in a question mark; keep the new ones the same.
  const out = ["chapter_one", "chapter_two", "finale"].map((k) => cleanText(parsed?.[k], 90).replace(/\s*\?+$/, ""));
  if (out.some((q) => q.length < 6)) throw new Error(`${who}'s questions came back incomplete: ${JSON.stringify(out)}`);
  return out;
}
