import { createHash } from "node:crypto";
import { TIERS } from "./config.mjs";
import { costOf } from "./pricing.mjs";

const withoutMarker = ({ cache_control, ...block }) => block;

/** Hash exactly ordered prompt prefixes, keeping only hashes and size estimates in memory. */
export function snapshotRequest(body, headers = {}) {
  const hash = createHash("sha256");
  const settings = JSON.stringify([body.model, body.thinking, body.output_config,
    body.tool_choice, body.context_management, headers["anthropic-beta"], headers["anthropic-version"]]);
  hash.update(settings);
  const prefixes = new Map();
  const checkpoints = [];
  let tokens = 0;
  let supported = true;
  let lastHash;
  const mark = (control) => {
    if (!control) return;
    if (control.type !== "ephemeral" || ![undefined, "5m", "1h"].includes(control.ttl)) {
      supported = false;
      return;
    }
    checkpoints.push({ hash: lastHash, tokens, ttl: control.ttl ?? "5m" });
  };
  const block = (kind, value) => {
    const clean = typeof value === "object" && value !== null ? withoutMarker(value) : value;
    const text = JSON.stringify([kind, clean]);
    hash.update(`${text.length}:${text}`);
    tokens += Math.ceil(text.length / 4);
    lastHash = hash.copy().digest("hex");
    prefixes.set(lastHash, tokens);
    mark(value?.cache_control);
  };
  for (const tool of body.tools ?? []) block("tool", tool);
  for (const system of Array.isArray(body.system) ? body.system : body.system ? [body.system] : []) block("system", system);
  for (const message of body.messages ?? []) {
    block("role", message.role);
    for (const content of Array.isArray(message.content) ? message.content : [message.content]) block("content", content);
  }
  mark(body.cache_control);
  return {
    model: body.model, tokens, prefixes, checkpoints, supported,
    fingerprint: hash.digest("hex"),
    minimum: TIERS.find((t) => t.id === body.model)?.minCacheTokens ?? Infinity,
    fallbackTtl: checkpoints.some((c) => c.ttl === "1h") ? "1h" : "5m",
  };
}

/** A selected tier is not cache evidence. Only a complete, successful matching response is. */
export function observeCache(state, snapshot, usage, status, startedAt) {
  if (status < 200 || status >= 300 || !usage?.valid || !usage.complete ||
      usage.model !== snapshot.model) return false;
  const total = usage.input + usage.cacheRead + usage.cacheCreate;
  // Server-tool iterations aggregate several prompts; their totals cannot calibrate one.
  if (usage.advisors.length || total === 0) return false;
  state.scales ??= {};
  state.scales[snapshot.model] = Math.min(4, Math.max(0.25, total / Math.max(1, snapshot.tokens)));
  const cached = usage.cacheRead + usage.cacheCreate;
  state.cache ??= [];
  const last = snapshot.checkpoints.at(-1);
  if (!last || !cached || !snapshot.supported) return true;
  for (const point of snapshot.checkpoints) {
    const entry = {
      model: snapshot.model, hash: point.hash,
      // Earlier mixed-TTL boundaries are estimated; the last boundary is measured.
      tokens: point === last ? cached : Math.floor(cached * point.tokens / last.tokens),
      expires: startedAt + (point.ttl === "1h" ? 3600000 : 300000),
      at: startedAt,
    };
    const previous = state.cache.find((c) => c.model === entry.model && c.hash === entry.hash);
    if (previous && previous.at > startedAt) continue;
    state.cache = state.cache.filter((c) => c.model !== entry.model || c.hash !== entry.hash);
    state.cache.push(entry);
  }
  // ponytail: bounded per-conversation evidence, not a provider cache replica.
  state.cache = state.cache.slice(-64);
  return true;
}

export function estimateInput(state, snapshot, now, { incumbent = false, hasHistory = false } = {}) {
  const scale = state.scales?.[snapshot.model] ?? 1;
  const tokens = Math.ceil(snapshot.tokens * scale);
  const last = snapshot.checkpoints.at(-1);
  let cacheable = last ? Math.ceil(last.tokens * scale) : 0;
  if (cacheable < snapshot.minimum) cacheable = 0;
  const candidates = (state.cache ?? []).filter((c) => c.model === snapshot.model);
  const matching = candidates.filter((c) => snapshot.prefixes.has(c.hash));
  let read = Math.max(0, ...matching.filter((c) => now < c.expires).map((c) => c.tokens));
  const unknown = incumbent && hasHistory && candidates.length === 0;
  // On resume or lost telemetry, favor the incumbent instead of inventing a cold cache.
  if (unknown) read = cacheable;
  read = Math.min(cacheable, read);
  const hour = snapshot.checkpoints.filter((c) => c.ttl === "1h").at(-1);
  return {
    model: snapshot.model, tokens, cacheable, read,
    oneHour: Math.min(cacheable, hour ? Math.ceil(hour.tokens * scale) : 0),
    ttl: snapshot.fallbackTtl, unknown, supported: snapshot.supported,
    minimum: snapshot.minimum,
  };
}

/** Whole-episode projection; newly generated output/tool results become later input. */
export function episodeCost(input, scenario, factor = 1) {
  if (!input?.supported) return null;
  let total = Math.ceil(input.tokens * factor);
  let cached = Math.min(total, Math.floor(input.read * factor));
  let prefix = Math.min(total, Math.ceil(input.cacheable * factor));
  let hour = Math.min(prefix, Math.ceil(input.oneHour * factor));
  let cost = 0;
  for (let i = 0; i < scenario.requests; i++) {
    if (prefix < input.minimum) { prefix = 0; cached = 0; hour = 0; }
    const value = costOf(input.model, {
      input: total - prefix, cacheRead: cached, cacheCreate: prefix - cached,
      cacheCreate1h: Math.max(0, hour - cached), output: scenario.output / scenario.requests,
    });
    if (value === null) return null;
    cost += value;
    cached = prefix;
    const growth = scenario.growth + scenario.output / scenario.requests;
    total += growth;
    if (input.cacheable > 0) {
      prefix += growth;
      if (input.ttl === "1h") hour += growth;
    }
  }
  return cost;
}
