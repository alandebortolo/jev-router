/**
 * List API prices, used as a common yardstick for what a routed session would have cost.
 *
 * Subscription users do not pay per token, so treat these as "equivalent API spend" rather
 * than a bill. Cache writes have different prices for five-minute and one-hour TTLs.
 * A cold destination pays for creation rather than a read; an expired incumbent does too.
 *
 * Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 */
export const PRICES_UPDATED = "2026-09-17";

/** USD per million tokens. Order matters: more specific ids must match first. */
const TABLE = [
  [/haiku-4-5|haiku-4\.5/, { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }],
  [/haiku-3-5|haiku-3\.5/, { input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 }],
  [/sonnet-5/, { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 }],
  [/sonnet-4/, { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 }],
  [/(?:fable|mythos)-5-1/, { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 }],
  [/(?:fable|mythos)-5/, { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 }],
  [/opus-5|opus-4-[5-9]/, { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 }],
  // Opus 4.1 and 4.0 are retired but still reachable on Bedrock/Vertex at 3x the current
  // line, so they must not fall through to the Opus 5 entry above.
  [/opus/, { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 }],
];

/** Price row for a model id, or null when the id is not recognised. */
export function priceOf(model) {
  if (typeof model !== "string") return null;
  const id = model.toLowerCase();
  return TABLE.find(([re]) => re.test(id))?.[1] ?? null;
}

/**
 * USD for one request. Returns null rather than 0 for an unknown model, so a pricing gap
 * shows up as missing data instead of silently understating a total.
 *
 * @param {string} model
 * @param {{input?: number, cacheRead?: number, cacheCreate?: number, cacheCreate1h?: number, output?: number}} usage
 */
export function costOf(model, usage = {}) {
  const p = priceOf(model);
  if (!p) return null;
  const values = [usage.input ?? 0, usage.cacheRead ?? 0, usage.cacheCreate ?? 0,
    usage.cacheCreate1h ?? 0, usage.output ?? 0];
  if (values.some((v) => !Number.isFinite(v) || v < 0) || values[3] > values[2]) return null;
  const m = 1e6;
  return (
    ((usage.input ?? 0) * p.input +
      ((usage.cacheCreate ?? 0) - (usage.cacheCreate1h ?? 0)) * p.cacheWrite +
      (usage.cacheCreate1h ?? 0) * p.input * 2 +
      (usage.cacheRead ?? 0) * p.cacheRead +
      (usage.output ?? 0) * p.output) /
    m
  );
}
