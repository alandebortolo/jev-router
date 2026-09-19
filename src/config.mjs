// Every routing decision knob lives here, so the whole policy is reviewable in one file.
import { choice } from "@typesafe-ai/sdk";

/**
 * Model tiers, cheapest first. `id` is what goes into the API request body; `family` is the
 * substring used to recognise whatever model Claude Code asked for, which may be an older
 * version within the same tier such as `claude-sonnet-4-6`. The capability flags come from
 * the Agent SDK's model catalogue: Haiku supports neither adaptive thinking nor effort, so
 * those fields have to be stripped when routing down to it.
 */
export const TIERS = [
  { name: "haiku", id: "claude-haiku-4-5-20251001", family: "haiku", thinking: false, effort: false, minCacheTokens: 4096 },
  { name: "sonnet", id: "claude-sonnet-5", family: "sonnet", thinking: true, effort: true, minCacheTokens: 1024 },
  { name: "opus", id: "claude-opus-5", family: "opus", thinking: true, effort: true, minCacheTokens: 512 },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true, minCacheTokens: 512 },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name) => TIER_NAMES.indexOf(name);

export const idOf = (name) => TIERS.find((t) => t.name === name)?.id;

export const tierSpec = (name) => TIERS.find((t) => t.name === name);

/**
 * Sentinel model id offered as an extra row in Claude Code's /model picker. Claude Code
 * sends it verbatim because it does not validate model names behind a custom base URL, so
 * its presence in a request is an exact signal that the user wants this turn routed. Any
 * other model means the user picked one themselves and it must be passed straight through.
 */
export const AUTO_MODEL = "jev-auto";

/** Whether a request should be routed, or passed through as the user's own choice. */
export const isAuto = (model) => model === AUTO_MODEL;

/** Tier name for a model string Claude Code sent, or null if we don't recognise it. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Fable bills extra usage credits, so it is opt-in. Everything else is covered by a normal
 * subscription.
 */
export const availableTiers = () =>
  TIER_NAMES.filter((n) => n !== "fable" || process.env.JEV_ALLOW_FABLE === "1");

export const THRESHOLDS = {
  /** Below this Jev confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.6,
  /** Safest tier to land on when Jev is unsure. */
  uncertainCeiling: "sonnet",
  /** Require savings in every scenario, with room for extra work on the cheaper model. */
  savingsMargin: 0.2,
  /** Bounds around the character-based estimate, calibrated with observed input usage. */
  contextUncertainty: 0.2,
  /**
   * Per-attempt Jev HTTP timeout and the hard wall-clock deadline for the whole routing
   * call. Measured: ~300-350ms warm, ~900-1000ms on the first call (TLS handshake), so the
   * deadline leaves room for one retry after a cold-start timeout.
   */
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};

// ponytail: bootstrap workload ranges, not calibrated forecasts; replace with episode
// quantiles once held-out session measurements justify them. Output is total per episode.
export const WORKLOADS = {
  short: [{ requests: 1, output: 128, growth: 128 }, { requests: 2, output: 1024, growth: 512 }],
  bounded: [{ requests: 4, output: 2000, growth: 512 }, { requests: 10, output: 8000, growth: 1024 }],
  long_output: [{ requests: 1, output: 2000, growth: 128 }, { requests: 2, output: 8000, growth: 512 }],
  uncertain: [{ requests: 1, output: 128, growth: 128 }, { requests: 8, output: 4000, growth: 1024 }],
};

/** Phrases that mean "the human already decided", checked against the raw prompt. */
export const OVERRIDE_PATTERNS = TIERS.map((t) => ({
  tier: t.name,
  re: new RegExp(`\\b(?:use|switch to|with|on)\\s+${t.name}\\b`, "i"),
}));

export const QUESTIONS = {
  model_tier: choice(
    [
      "Pick the cheapest Claude model tier that can fully complete this coding request in one pass, without a retry on a stronger model.",
      "Judge the reasoning the request demands, not the length of the reply it asks for. A request that wants a one-line answer to a hard debugging or design question still needs a strong model; a request for a long but mechanical edit does not.",
      "Keeping session.current_model is a valid choice. Escalate for a material capability benefit, not because an expensive model might write a nicer answer. Do not infer missing history from a short follow-up.",
    ],
    {
      haiku: {
        what: "Trivial, mechanical, or purely factual work.",
        signals: [
          "Rename a symbol, fix a typo, reformat, add a comment",
          "Answer a short factual question about a known file",
          "Run one obvious command and report the output",
        ],
        not_for: "Anything requiring design judgement or multi-file reasoning.",
      },
      sonnet: {
        what: "Ordinary day-to-day engineering with a clear, bounded shape.",
        signals: [
          "Implement a well-specified function, endpoint, or component",
          "Write or fix tests for existing behaviour",
          "Localised bug fix where the cause is already understood",
        ],
        not_for: "Open-ended architecture, subtle concurrency, or deep unknown-cause debugging.",
      },
      opus: {
        what: "Hard reasoning, ambiguity, or high blast radius.",
        signals: [
          "Debug a failure whose cause is unknown",
          "Design or refactor across several modules",
          "Security, auth, concurrency, data-migration, or money-handling logic",
        ],
        not_for: "Work that a competent mid-level engineer would finish without thinking hard.",
      },
      fable: {
        what: "Very large or very long-running tasks that exceed the others' practical reach.",
        signals: [
          "Whole-repo migration or framework upgrade",
          "Task requiring an unusually large amount of context to be held at once",
          "Long autonomous multi-hour execution",
        ],
        not_for: "Anything a single focused session on Opus would finish. Costs extra usage credits.",
      },
    },
  ),
  workload: choice(
    "Classify the work in THIS user turn, including its model/tool round trips, not hypothetical future user prompts. Do not calculate prices or predict exact token counts.",
    {
      short: "A short answer, lookup, or one obvious command.",
      bounded: "A self-contained implementation or mechanical task with several tool rounds and clear acceptance criteria.",
      long_output: "A substantial requested document or code output, with little investigation.",
      uncertain: "Open-ended investigation or insufficient information to predict the work.",
    },
  ),
  context_dependence: choice(
    "Could this request be understood on its own? We do not send you the conversation history. Treat 'continue', 'implement that', corrections and approvals referring to prior work as dependent, regardless of their length.",
    {
      standalone: "The prompt supplies enough task intent to judge capability independently.",
      dependent: "Essential task intent or constraints come from the unseen conversation.",
    },
  ),
};
