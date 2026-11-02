import { clipText, type JarvisHistoryEntry, type JarvisSearchOption } from "./jarvis-context";

const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
const PLAN_THRESHOLD = 0.6;
const SEARCH_THRESHOLD = 0.5;
const OVERVIEW_THRESHOLD = 0.75;
const HISTORY_CHARS = 600;
const SUMMARY_CHARS = 240;
const NO_MATCH = "none";
const PASSAGE_FLOOR = 0.2;

export interface RouterVerdict {
  plan: boolean;
  probability: number;
  /** La demande décrit une conversation à retrouver : Jev peut la désigner sans Claude. */
  search: boolean;
  searchProbability: number;
  /** La demande porte sur l'état général : l'état de Pupitre suffit à répondre. */
  overview: "waiting" | "running" | null;
  overviewProbability: number;
}

export interface SearchChoice {
  /** Les options, de la plus probable à la moins probable, avec les messages qui répondent quand Jev a pu les départager. */
  ranking: Array<{ alias: string; probability: number; passages?: number[] }>;
  /** Probabilité qu'aucune option ne soit la bonne. */
  none: number;
}

export interface JarvisRouter {
  ready(): boolean;
  decide(input: { question: string; history: JarvisHistoryEntry[]; signal: AbortSignal }): Promise<RouterVerdict>;
  choose(input: { question: string; history: JarvisHistoryEntry[]; options: JarvisSearchOption[]; signal: AbortSignal }): Promise<SearchChoice>;
}

const PLAN_QUESTION = {
  type: "noul",
  instructions: "Does handling this request require a plan of several actions that change things, rather than a direct answer?",
  criteria: {
    true: "The request asks to carry out at least two actions that modify something (send a message to an agent, start a new conversation, archive, pin, stop a running turn), or to write work for agents: the brief of a new conversation, an operation over several conversations.",
    false: "The request asks to find, summarize, explain, say who is waiting or what is running, open a conversation, or do one single simple action.",
  },
};

/**
 * Une recherche, c'est ce qui reste quand la demande n'est ni une question à
 * laquelle répondre ni un ordre : poser la question à l'endroit laissait
 * échapper les fragments tapés comme dans une barre de recherche.
 */
const EXPLICIT_QUESTION = {
  type: "noul",
  instructions: "Does this request explicitly ask a question to answer, or explicitly order an action, other than finding or opening a conversation?",
  criteria: {
    true: "An explicit question that needs an answer written out (why, how, what was decided, did it work, who is waiting, what is running), an explicit order (archive, pin, send, stop, start, summarize, plan), or small talk.",
    false: "It asks where something was discussed or to find or open a conversation, or it is only a fragment typed like a search query: a subject, a detail, a memory of what happened, keywords, an identifier.",
  },
};

const WAITING_QUESTION = {
  type: "noul",
  instructions: "Is the person only asking which conversations or agents are waiting for them right now?",
  criteria: {
    true: "A general question about who or what is waiting for the person: an answer, a decision, a validation.",
    false: "It asks about what is running rather than what is waiting, asks about one precise conversation, asks why an agent waits, asks to act on waiting agents, asks for a summary, looks for a past discussion, or asks something else.",
  },
};

const RUNNING_QUESTION = {
  type: "noul",
  instructions: "Is the person only asking what is running right now: which agents are working, which servers are listening?",
  criteria: {
    true: "A general question about what is currently running or in progress: agents at work, servers listening.",
    false: "It asks about what is waiting rather than what is running, asks about one precise conversation, port or server, asks why something runs, asks to act on what runs, asks for a summary of the work, looks for a past discussion, or asks something else.",
  },
};

const CHOICE_INSTRUCTIONS = "Which conversation is the person looking for? Pick the one whose content matches what the request describes. A shared word is not enough.";
const NO_MATCH_CRITERION = "None of these conversations covers what the person is looking for.";
const PASSAGE_INSTRUCTIONS = "Which passage of this conversation shows what the person is looking for?";

function previousExchanges(history: JarvisHistoryEntry[]) {
  return history.slice(-2).map((entry) => ({ role: entry.role, text: clipText(entry.text, HISTORY_CHARS) }));
}

function probabilityOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("réponse TypeSafe sans probabilité");
  return value;
}

function optionCriterion(option: JarvisSearchOption) {
  return {
    title: option.title,
    project: option.projectName,
    ...(option.summary ? { summary: clipText(option.summary, SUMMARY_CHARS) } : {}),
    ...(option.lastMessage ? { last_message: option.lastMessage } : {}),
    ...(option.passages.length > 0 ? { passages: option.passages.map((passage) => passage.text) } : {}),
  };
}

function passageQuestion(option: JarvisSearchOption) {
  return {
    type: "choice",
    instructions: { question: PASSAGE_INSTRUCTIONS, conversation: option.title },
    criteria: Object.fromEntries(option.passages.map((passage) => [`m${passage.id}`, passage.text])),
  };
}

/** Les messages que Jev retient, le meilleur d'abord ; rien si la réponse ne permet pas de les départager. */
function passagesFrom(option: JarvisSearchOption, probabilities: Record<string, unknown> | undefined): number[] | undefined {
  if (!probabilities) return undefined;
  const scored = option.passages
    .map((passage) => ({ id: passage.id, probability: probabilities[`m${passage.id}`] }))
    .filter((item): item is { id: number; probability: number } => typeof item.probability === "number")
    .sort((left, right) => right.probability - left.probability);
  return scored.length === 0 ? undefined : scored.filter((item, index) => index === 0 || item.probability >= PASSAGE_FLOOR).map((item) => item.id);
}

/** Jev, le modèle de décision de TypeSafe, trie la demande et désigne une conversation en une fraction de seconde. */
export function jevRouter(apiKey: () => string | null, fetchImpl: typeof fetch = fetch): JarvisRouter {
  async function ask<T>(state: unknown, questions: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    const key = apiKey();
    if (!key) throw new Error("clé TypeSafe absente");
    const response = await fetchImpl(SYSTEM_ONE_URL, {
      method: "POST",
      signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    });
    if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status} : ${(await response.text()).slice(0, 200)}`);
    return await response.json() as T;
  }

  return {
    ready: () => apiKey() !== null,
    async decide({ question, history, signal }) {
      type Answers = Record<"plan" | "explicit" | "waiting" | "running", { noul?: unknown } | undefined>;
      // Seul le plan dépend de ce qui précède (« archive-les »). Montré aux autres questions,
      // l'échange précédent leur fait rater une demande qui se suffit à elle-même.
      const plan = { ...PLAN_QUESTION, instructions: { question: PLAN_QUESTION.instructions, previous_exchanges: previousExchanges(history) } };
      const body = await ask<{ answers?: Partial<Answers> }>(
        { request: question },
        { plan, explicit: EXPLICIT_QUESTION, waiting: WAITING_QUESTION, running: RUNNING_QUESTION },
        signal,
      );
      const probability = probabilityOf(body.answers?.plan?.noul);
      const searchProbability = Math.round((1 - probabilityOf(body.answers?.explicit?.noul)) * 100) / 100;
      // Les deux questions se ressemblent assez pour monter ensemble : seule la plus probable compte.
      const waiting = probabilityOf(body.answers?.waiting?.noul);
      const running = probabilityOf(body.answers?.running?.noul);
      const overviewProbability = Math.max(waiting, running);
      return {
        plan: probability >= PLAN_THRESHOLD,
        probability,
        search: searchProbability >= SEARCH_THRESHOLD,
        searchProbability,
        overview: overviewProbability < OVERVIEW_THRESHOLD ? null : waiting >= running ? "waiting" : "running",
        overviewProbability,
      };
    },
    async choose({ question, history, options, signal }) {
      const state = { request: question, previous_exchanges: previousExchanges(history) };
      const body = await ask<{ answers?: Record<string, { probabilities?: Record<string, unknown> } | undefined> }>(state, {
        best: {
          type: "choice",
          instructions: CHOICE_INSTRUCTIONS,
          criteria: {
            ...Object.fromEntries(options.map((option) => [option.alias, optionCriterion(option)])),
            [NO_MATCH]: NO_MATCH_CRITERION,
          },
        },
        ...Object.fromEntries(options
          .filter((option) => option.passages.length >= 2)
          .map((option) => [`passages_${option.alias}`, passageQuestion(option)])),
      }, signal);
      const probabilities = body.answers?.best?.probabilities;
      if (!probabilities) throw new Error("réponse TypeSafe sans probabilité");
      return {
        ranking: options
          .map((option) => ({
            alias: option.alias,
            probability: probabilityOf(probabilities[option.alias] ?? 0),
            passages: passagesFrom(option, body.answers?.[`passages_${option.alias}`]?.probabilities),
          }))
          .sort((left, right) => right.probability - left.probability),
        none: probabilityOf(probabilities[NO_MATCH] ?? 0),
      };
    },
  };
}
