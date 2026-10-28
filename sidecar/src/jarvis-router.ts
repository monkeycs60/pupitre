import { clipText, type JarvisHistoryEntry } from "./jarvis-context";

const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
const PLAN_THRESHOLD = 0.6;
const HISTORY_CHARS = 600;

export interface RouterVerdict {
  plan: boolean;
  probability: number;
}

export interface JarvisRouter {
  ready(): boolean;
  decide(input: { question: string; history: JarvisHistoryEntry[]; signal: AbortSignal }): Promise<RouterVerdict>;
}

const PLAN_QUESTION = {
  type: "noul",
  instructions: "Does handling this request require a plan of several actions that change things, rather than a direct answer?",
  criteria: {
    true: "The request asks to carry out at least two actions that modify something (send a message to an agent, start a new conversation, archive, pin, stop a running turn), or to write work for agents: the brief of a new conversation, an operation over several conversations.",
    false: "The request asks to find, summarize, explain, say who is waiting or what is running, open a conversation, or do one single simple action.",
  },
};

/** Jev, le modèle de décision de TypeSafe, estime en une fraction de seconde si la demande appelle un plan. */
export function jevRouter(apiKey: () => string | null, fetchImpl: typeof fetch = fetch): JarvisRouter {
  return {
    ready: () => apiKey() !== null,
    async decide({ question, history, signal }) {
      const key = apiKey();
      if (!key) throw new Error("clé TypeSafe absente");
      const response = await fetchImpl(SYSTEM_ONE_URL, {
        method: "POST",
        signal,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: JEV_MODEL,
          state: {
            request: question,
            previous_exchanges: history.slice(-2).map((entry) => ({ role: entry.role, text: clipText(entry.text, HISTORY_CHARS) })),
          },
          questions: { plan: PLAN_QUESTION },
        }),
      });
      if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status} : ${(await response.text()).slice(0, 200)}`);
      const body = await response.json() as { answers?: { plan?: { noul?: unknown } } };
      const probability = body.answers?.plan?.noul;
      if (typeof probability !== "number" || !Number.isFinite(probability)) throw new Error("réponse TypeSafe sans probabilité");
      return { plan: probability >= PLAN_THRESHOLD, probability };
    },
  };
}
