import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { costOf } from "./pricing.mjs";
import { log } from "./log.mjs";

export const usageEnabled = () => process.env.JEV_USAGE === "1";
export const usageFile = () =>
  process.env.JEV_USAGE_FILE ?? join(homedir(), ".jev-claude-usage.jsonl");

function tokenUsage(u) {
  const result = {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheCreate: u.cache_creation_input_tokens ?? 0,
    cacheCreate1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
  const five = u.cache_creation?.ephemeral_5m_input_tokens;
  result.valid = Object.values(result).every((n) => Number.isSafeInteger(n) && n >= 0) &&
    result.cacheCreate1h <= result.cacheCreate &&
    (five === undefined || (Number.isSafeInteger(five) && five >= 0 && five + result.cacheCreate1h === result.cacheCreate));
  result.creationDetailed = u.cache_creation != null;
  return result;
}

/** Incremental SSE/JSON accounting. Never retains generated text or tool results. */
export function createUsageCollector() {
  const decoder = new StringDecoder("utf8");
  const out = { model: null, input: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0,
    output: 0, creationDetailed: false, advisors: [], complete: false, valid: true, stopReason: null };
  let buffer = "";
  let found = false;
  let streaming = false;
  let overflow = false;
  let warned = false;
  const invalid = (reason) => {
    out.valid = false;
    if (!warned) log(`usage unavailable: ${reason}`);
    warned = true;
  };
  function accept(p) {
    if (p.type === "error" || p.error) invalid("upstream response contains an error");
    if (p.type === "message_stop") out.complete = true;
    const msg = p.message ?? p;
    if (typeof msg.model === "string") out.model = msg.model;
    out.stopReason = p.delta?.stop_reason ?? msg.stop_reason ?? out.stopReason;
    const raw = msg.usage ?? p.usage;
    if (!raw || typeof raw !== "object") return;
    found = true;
    const u = tokenUsage(raw);
    if (!u.valid) invalid("invalid token counts");
    for (const k of ["input", "cacheRead", "cacheCreate", "cacheCreate1h", "output"]) {
      out[k] = Math.max(out[k], u[k]);
    }
    out.creationDetailed ||= u.creationDetailed;
    if (Array.isArray(raw.iterations)) {
      out.advisors = raw.iterations.filter((it) => it.type === "advisor_message")
        .map((it) => ({ model: it.model, ...tokenUsage(it) }));
      if (out.advisors.some((it) => !it.valid)) invalid("invalid advisor counts");
    }
  }
  function json(text) {
    try { accept(JSON.parse(text)); }
    catch { invalid("malformed or truncated response"); }
  }
  function line(text) {
    if (/^(event|data):/.test(text)) streaming = true;
    if (text.startsWith("data:")) {
      const data = text.slice(5).trim();
      if (data && data !== "[DONE]") json(data);
    }
  }
  return {
    write(chunk) {
      if (overflow) return;
      buffer += Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk;
      if (/^\s*(event|data):/.test(buffer)) streaming = true;
      if (streaming) {
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          line(buffer.slice(0, newline).trimEnd());
          buffer = buffer.slice(newline + 1);
        }
      }
      if (buffer.length > 2 * 1024 * 1024) {
        overflow = true;
        buffer = "";
        invalid("response event exceeds 2 MiB accounting limit");
      }
    },
    finish() {
      buffer += decoder.end();
      if (!overflow && buffer.trim()) {
        if (streaming) line(buffer.trim());
        else {
          json(buffer);
          out.complete = out.valid;
        }
      }
      buffer = "";
      return found ? out : null;
    },
  };
}

export function parseUsage(text) {
  if (typeof text !== "string" || !text) return null;
  const collector = createUsageCollector();
  collector.write(text);
  return collector.finish();
}

export function recordUsage(record) {
  try { appendFileSync(usageFile(), JSON.stringify(record) + "\n"); }
  catch (err) { log(`could not record usage: ${err.message}`); }
}

/** Legacy rows without TTL detail use 5m prices; live requests supply a TTL fallback. */
export function usageRecord({ text, usage, status, requested, tier, reason, routed, session, key,
  turn, startedAt, estimate, fallbackTtl = "5m" }) {
  const u = usage ?? parseUsage(text);
  const estimated = !!u && !u.creationDetailed && u.cacheCreate > 0 && fallbackTtl !== "5m";
  const cacheCreate1h = estimated ? u.cacheCreate : (u?.cacheCreate1h ?? 0);
  const executorCost = u?.valid ? costOf(u.model, { ...u, cacheCreate1h }) : null;
  const costs = (u?.advisors ?? []).map((it) => costOf(it.model, it));
  const advisorCost = costs.includes(null) ? null : costs.reduce((a, b) => a + b, 0);
  return {
    at: new Date().toISOString(), startedAt, session, conversation: key, turn,
    status, routed, requested, tier: tier ?? null, reason: reason ?? null,
    served: u?.model ?? null,
    input: u?.input ?? null, cacheRead: u?.cacheRead ?? null,
    cacheCreate: u?.cacheCreate ?? null, cacheCreate1h, output: u?.output ?? null,
    complete: u?.complete ?? false, costEstimated: estimated,
    executorCost, advisorCost, advisors: u?.advisors ?? [],
    cost: executorCost === null || advisorCost === null ? null : executorCost + advisorCost,
    estimate: estimate ?? null,
  };
}
