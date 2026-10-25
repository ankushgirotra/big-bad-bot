// Meta's Muse writes each tale's questions when it can. It's tried first on every tale,
// and Claude (the wolf's model) takes over whenever it fails. That's the only thing Muse
// does in the game: the wolf itself is always Claude.

import { parseQuestions, QUESTION_PROMPT, QUESTION_SCHEMA, questionAsk } from "./questions.ts";
import type { QuestionWriter } from "./store.ts";

/** The Muse model, by its API id and the name the console uses. */
export const MUSE_MODEL = { id: "muse-spark-1.3", name: "Spark 1.3" };

/** Short, so a Muse outage still leaves Claude time to write the questions while the host waits. */
export const MUSE_TIMEOUT_MS = 8_000;

export interface MuseConfig {
  apiKey: string;
  /** Only tests point this elsewhere (a fake Meta Model API). */
  baseURL?: string;
}

export class Muse {
  constructor(readonly cfg: MuseConfig) {}

  /** Three new questions from Muse, through the Meta Model API's OpenAI-compatible chat endpoint. */
  async questions(recent: string[]): Promise<string[]> {
    if (!this.cfg.apiKey) throw new Error("there's no Muse API key in server/keys.ts");
    const base = (this.cfg.baseURL ?? "https://api.meta.ai/v1").replace(/\/+$/, "");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MUSE_MODEL.id,
        // Measured: about 1.5–2s at "minimal" with questions as good as at "low" (5–7s).
        reasoning_effort: "minimal",
        // Muse reasons before it answers; leave room for both.
        max_completion_tokens: 2000,
        messages: [{ role: "system", content: QUESTION_PROMPT }, { role: "user", content: questionAsk(recent) }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "questions", strict: true, schema: QUESTION_SCHEMA },
        },
      }),
      signal: AbortSignal.timeout(MUSE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Muse answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return parseQuestions(String(data?.choices?.[0]?.message?.content ?? ""), "Muse");
  }
}

/** Muse first; on any failure, the fallback (Claude). Says which on the console every time. */
export function museFirst(muse: Muse, fallback: QuestionWriter): QuestionWriter {
  return async (recent) => {
    let questions: string[];
    try {
      questions = await muse.questions(recent);
    } catch {
      console.log(`Muse ${MUSE_MODEL.name} service interruption detected, using fallback inference provider...`);
      return await fallback(recent);
    }
    console.log(`No Muse service interruption detected. Using Muse ${MUSE_MODEL.name}`);
    return questions;
  };
}
