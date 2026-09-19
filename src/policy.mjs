import { TIER_NAMES, THRESHOLDS, OVERRIDE_PATTERNS, WORKLOADS, rankOf } from "./config.mjs";
import { episodeCost } from "./cache.mjs";

/** The tier the user named explicitly in the prompt, or null. */
export function detectOverride(prompt) {
  const hit = OVERRIDE_PATTERNS.find((p) => p.re.test(prompt ?? ""));
  return hit ? hit.tier : null;
}

/**
 * Nearest tier the account can actually run. Prefers stepping up rather than down so we
 * never silently hand a hard task to a weaker model, but never steps up into `fable`
 * (which bills extra usage credits) unless that is what was asked for.
 */
function clampToAvailable(tier, available) {
  if (available.includes(tier)) return tier;
  const rank = rankOf(tier);
  const up = TIER_NAMES.filter(
    (t, i) => i > rank && available.includes(t) && (t !== "fable" || tier === "fable"),
  );
  if (up.length) return up[0];
  const down = TIER_NAMES.filter((t, i) => i < rank && available.includes(t));
  return down.length ? down[down.length - 1] : null;
}

const confident = (answer) => answer && Number.isFinite(answer.confidence) &&
  answer.confidence >= THRESHOLDS.minConfidence && answer.confidence <= 1;

/** Short approvals/references must not become cheap "standalone" tasks. */
export function isContinuation(prompt) {
  return /^(?:yes|yep|yeah|ok(?:ay)?|sure|continue|proceed|go ahead|do (?:it|that)|implement (?:it|that)|fix (?:it|that)|try again|same again|keep going)\b[.! ,]*(?:please[.! ]*)?$/i.test(prompt.trim());
}

export function evaluateSwitch({ current, target, jev }) {
  const workload = confident(jev?.workload) && Object.hasOwn(WORKLOADS, jev.workload.choice)
    ? jev.workload.choice : "uncertain";
  const scenarios = [];
  for (const work of WORKLOADS[workload]) {
    for (const factor of [1 - THRESHOLDS.contextUncertainty, 1 + THRESHOLDS.contextUncertainty]) {
      const stay = episodeCost(current, work, factor);
      const change = episodeCost(target, work, factor);
      if (stay === null || change === null) return { worthwhile: false, workload, reason: "cost-unavailable", scenarios: [] };
      scenarios.push({ requests: work.requests, output: work.output, contextFactor: factor,
        stay, switch: change, saving: stay - change });
    }
  }
  return {
    worthwhile: scenarios.every((s) => s.saving > 0 && s.switch <= s.stay * (1 - THRESHOLDS.savingsMargin)),
    workload, reason: "episode-cost", scenarios,
    current, target,
  };
}

/**
 * Turns a Jev answer into the model we will actually run. Pure and total: any missing,
 * malformed, or unavailable input falls back to the model already in use.
 *
 * @param {object} input
 * @param {string} input.prompt        raw user prompt, for explicit-override detection
 * @param {?{choice: string, confidence: number}} input.jev  null when Jev failed
 * @param {string} input.current       tier currently active in the session
 * @param {string[]} input.available   tier names the account can run
 * @param {boolean} input.hasHistory   whether the conversation already has turns
 * @param {Object<string, object>} input.costs  per-tier `estimateInput()` snapshots; without
 *   them no downgrade can be priced and every one is refused as "cost-unavailable"
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function decide({ prompt, jev, current, available, hasHistory = false, costs }) {
  const settle = (tier, reason) => {
    const final = clampToAvailable(tier, available) ?? current;
    const why = final === tier ? reason : `${reason}+unavailable`;
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current };
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  if (!jev || !TIER_NAMES.includes(jev.choice) || !Number.isFinite(jev.confidence) ||
      jev.confidence < 0 || jev.confidence > 1) return settle(current, "jev-unavailable");

  let target = jev.choice;

  if (jev.confidence < THRESHOLDS.minConfidence) {
    if (rankOf(target) < rankOf(current)) return settle(current, "low-confidence-no-downgrade");
    const ceiling = Math.max(rankOf(current), rankOf(THRESHOLDS.uncertainCeiling));
    if (rankOf(target) > ceiling) return settle(TIER_NAMES[ceiling], "low-confidence-capped");
  }

  const requested = target;
  target = clampToAvailable(target, available) ?? current;
  if (rankOf(target) < rankOf(current)) {
    if (hasHistory && (isContinuation(prompt) || !confident(jev.contextDependence) ||
        jev.contextDependence.choice !== "standalone")) return settle(current, "context-dependent-no-downgrade");
    if (!costs?.[current] || !costs?.[target]) return settle(current, "cost-unavailable");
    const estimate = evaluateSwitch({ current: costs[current], target: costs[target], jev });
    return { ...settle(estimate.worthwhile ? target : current,
      estimate.worthwhile ? "episode-savings" : estimate.reason === "cost-unavailable" ? "cost-unavailable" : "cache-rebuild-not-repaid"),
      estimate };
  }

  return settle(requested, "jev");
}
