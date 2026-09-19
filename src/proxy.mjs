import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { tierOf, idOf, availableTiers, tierSpec, isAuto } from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";
import { writeStatus } from "./status.mjs";
import { usageEnabled, usageRecord, recordUsage, createUsageCollector } from "./usage.mjs";
import { snapshotRequest, observeCache, estimateInput } from "./cache.mjs";

const UPSTREAM = "api.anthropic.com";
const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * The tier an evaluation harness has pinned, if any.
 *
 * Only a known tier name counts. A typo silently falling through to normal routing would make
 * a benchmark compare a tier against itself and report no difference, so an unrecognised value
 * is treated as unset.
 */
export const forcedTier = () => {
  const name = process.env.JEV_FORCE_TIER;
  return name && tierSpec(name) ? name : null;
};

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn can continue for many requests while Claude works through tool calls, and those
 * continuations end in a `tool_result` rather than typed text. Routing them would re-ask
 * Jev on every tool call and let the model flip mid-task, so only the opening request of a
 * turn counts. Claude Code also injects `<system-reminder>` blocks into the user message,
 * which are noise to a router and measurably blunt Jev's confidence, so they are removed.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null; // auxiliary call
  const last = body?.messages?.[body.messages.length - 1];
  if (!last || last.role !== "user") return null;
  let text;
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    if (last.content.some((b) => b.type === "tool_result")) return null;
    text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
}

/**
 * Points a request at a tier, removing request fields that tier cannot accept. Claude Code
 * composes the body for whatever model it thinks it is talking to, so downgrading to Haiku
 * while leaving `thinking: {type:"adaptive"}` in place is a hard 400.
 */
export function applyTier(body, tierName) {
  const tier = tierSpec(tierName);
  if (!tier) return body;
  body.model = tier.id;
  if (!tier.thinking) {
    delete body.thinking;
    // A context-management strategy that prunes thinking blocks is itself rejected once
    // thinking is gone, so it has to go with it.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }
  if (!tier.effort && body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  return body;
}

/**
 * Identifies the conversation a request belongs to. Claude Code runs sub-agents through the
 * same endpoint, so a single pinned model would let a sub-agent's choice leak into the main
 * conversation.
 *
 * Only stable fields may be used. Claude Code moves its `cache_control` breakpoint between
 * requests and rewrites message metadata, so the key is built from the session id plus the
 * text of the first message, which is fixed once a conversation starts and differs between
 * the main agent and each sub-agent.
 */
/**
 * Session id Claude Code embeds in request metadata, or "" when it isn't present.
 * `metadata.user_id` is a JSON string, not a plain id.
 */
export function sessionOf(body) {
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

export function conversationKey(body) {
  const session = sessionOf(body);
  let agent = body?.metadata?.agent_id ?? "";
  try {
    agent ||= JSON.parse(body?.metadata?.user_id ?? "{}").agent_id ?? "";
  } catch { /* sessionOf handles legacy non-JSON metadata too */ }
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return createHash("sha1").update(JSON.stringify([session, agent, text])).digest("hex").slice(0, 12);
}

/**
 * Records the tier Claude Code is asking for and reports whether the user has taken manual
 * control. The first tier seen in a conversation is the baseline; any later change means the
 * user picked a model with /model, and an explicit choice must beat the router. Compared by
 * tier rather than exact model id, because Claude Code varies the id within a tier.
 */
export function observeModel(state, current) {
  state.baseline ??= current;
  if (current !== state.baseline) state.manual = true;
  return state.manual;
}


export async function startProxy({ route = askJev, upstreamRequest = https.request, now = Date.now, publish = writeStatus } = {}) {
  // Tier routed for each conversation's turn in flight, reused by its follow-up requests and
  // by the cache-rebuild guard, which needs to know what the prompt cache was built on.
  const convos = new Map();
  const stateFor = (key) => {
    let s = convos.get(key);
    if (!s) {
      if (convos.size >= 50) {
        const idle = [...convos].find(([, state]) => !state.inflight && !state.routing);
        if (idle) convos.delete(idle[0]);
      }
      convos.set(key, (s = { tier: null }));
    }
    return s;
  };

  const server = http.createServer((req, res) => {
    // Claude Code probes the base URL before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      // Carried into the response handler so the ledger can attribute tokens to the routing
      // decision that produced them.
      const meta = { messages: /^\/v1\/messages/.test(req.url ?? ""), routed: false, requested: null, tier: null, reason: null, session: "", key: null };
      let state;
      let snapshot;

      if (meta.messages && req.method === "POST" && !req.url.includes("count_tokens")) {
        try {
          const body = JSON.parse(out.toString());
          meta.requested = body.model ?? null;
          meta.session = sessionOf(body);
          // Claude Code's request shape is undocumented and moves; JEV_DUMP captures it.
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));
          const agentRequest = Array.isArray(body.tools) && body.tools.length > 0;
          if (agentRequest || isAuto(body.model)) {
            meta.key = conversationKey(body);
            state = stateFor(meta.key);
            if (state.networkComplete) await state.feedback;
          }

          // Anything that is not the sentinel is a model the user chose, and an explicit
          // choice beats the router. That also covers Claude Code's own cheap Haiku calls
          // for titles and summaries, which must never be pinned up to the session's tier.
          if (!isAuto(body.model)) {
            debug(`passthrough, user selected ${body.model}`);
            // Only a real agent turn reflects the user's choice. Claude Code's own auxiliary
            // calls carry no tools and must not flip the status line to manual mid-session.
            if (Array.isArray(body.tools)) {
              state.turn = null;
              state.decision = null;
              publish(sessionOf(body), { manual: true, at: now() });
            }
          } else {
            const key = meta.key;
            meta.routed = true;
            meta.key = key;
            // What the prompt cache was built on, which is what a downgrade would discard.
            const current = state.servedTier ?? state.tier ?? "sonnet";
            const prompt = newTurnPrompt(body);
            let fresh = null;
            // Evaluation harnesses need to pin a tier to compare tiers on identical turns.
            // Done here, rather than via `claude --model`, because Claude Code silently
            // falls back to Sonnet for aliases a subscription cannot select.
            const forced = forcedTier();
            if (forced) {
              state.tier = forced;
              fresh = { confidence: null, reason: "forced" };
            } else if (prompt) {
              const turn = snapshotRequest(body).fingerprint;
              if (state.turn === turn && state.decision) {
                fresh = await state.decision;
              } else if (state.inflight || state.routing) {
                // Without distinct agent metadata, a simultaneous fork is ambiguous.
                fresh = { confidence: null, reason: "concurrent-conversation-pinned" };
              } else {
                state.turn = turn;
                state.routing = true;
                state.decision = (async () => {
                  const available = availableTiers();
                  const hasHistory = body.messages.some((m) => m.role === "assistant");
                  const costs = {};
                  for (const name of new Set([...available, current])) {
                    const candidate = applyTier(structuredClone(body), name);
                    costs[name] = estimateInput(state, snapshotRequest(candidate, req.headers), now(),
                      { incumbent: name === current, hasHistory });
                  }
                  const contextTokens = costs[current].tokens;
                  let jev;
                  try { jev = await route({ prompt, current, contextTokens, available }); }
                  catch (err) { log(`routing failed, keeping ${current}: ${err.message}`); }
                  const result = decide({ prompt, jev, current, available, hasHistory, costs });
                  state.tier = result.tier;
                  debug(`${key} ${current} -> ${result.tier} (${result.reason}) ctx~${contextTokens}`);
                  return { confidence: jev?.confidence ?? null, reason: result.reason, estimate: result.estimate ?? null };
                })();
                try { fresh = await state.decision; }
                finally { state.routing = false; }
              }
            }
            // The sentinel is not a real model, so every routed request must be rewritten,
            // including follow-ups that reuse the tier chosen for the turn.
            const tier = state.tier ?? current;
            debug(`${key} rewrite ${body.model} -> ${idOf(tier)}`);
            applyTier(body, tier);
            meta.tier = tier;
            meta.turn = state.turn;
            meta.estimate = fresh?.estimate;
            meta.reason = fresh?.reason ?? "pinned";
            // Publish what went out. Claude Code's UI shows the row you picked, not the tier
            // it resolved to, so the status line is the only place this is visible.
            publish(sessionOf(body), { tier, ...fresh, at: now() });
          }
          if (state) snapshot = snapshotRequest(body, req.headers);
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      const headers = { ...req.headers, host: UPSTREAM };
      delete headers["content-length"];
      // Both the model echo and token accounting need to read the response body, which is
      // only possible uncompressed. Worth the bandwidth only when one of them is asked for.
      const capture = snapshot != null || usageEnabled() || process.env.JEV_DEBUG;
      if (capture) delete headers["accept-encoding"];
      meta.startedAt = new Date(now()).toISOString();
      const startedAt = now();
      let resolveFeedback;
      if (state) {
        state.inflight = (state.inflight ?? 0) + 1;
        state.networkComplete = false;
        state.feedback = new Promise((resolve) => { resolveFeedback = resolve; });
      }
      let finished = false;
      const release = () => {
        if (!finished && state) state.inflight--;
        finished = true;
        resolveFeedback?.();
      };
      const upstream = upstreamRequest(
        { hostname: UPSTREAM, path: req.url, method: req.method, headers },
        (up) => {
          up.on("end", () => { if (state) state.networkComplete = true; });
          res.writeHead(up.statusCode, up.headers);
          // Report the model the API itself says it used, so the routing can be confirmed
          // from the wire rather than trusted from our own decision log. Claude Code's UI
          // always shows the model it asked for, never the one we rewrote to.
          if (process.env.JEV_DEBUG) {
            let seen = false;
            up.on("data", (c) => {
              if (seen) return;
              const m = /"model"\s*:\s*"([^"]+)"/.exec(c.toString("utf8"));
              if (!m) return;
              seen = true;
              debug(`${up.statusCode} served by ${m[1]}`);
            });
          }
          if (capture && meta.messages) {
            const collector = createUsageCollector();
            const encoding = up.headers["content-encoding"];
            const decompress = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[encoding];
            const readable = decompress ? up.pipe(decompress()) : up;
            const supported = !encoding || encoding === "identity" || !!decompress;
            if (!supported) log(`usage unavailable: unsupported content encoding ${encoding}`);
            readable.on("data", (c) => { if (supported) collector.write(c); });
            readable.on("error", (err) => {
              log(`usage unavailable: ${err.message}`);
              release();
            });
            readable.on("end", () => {
              const usage = supported ? collector.finish() : null;
              if (snapshot && state) {
                observeCache(state, snapshot, usage, up.statusCode, startedAt);
                if (usage?.complete && usage.valid && up.statusCode >= 200 && up.statusCode < 300) {
                  state.servedTier = tierOf(usage.model) ?? state.servedTier;
                } else {
                  log(`no cache evidence for ${meta.key}: incomplete or failed response`);
                }
              }
              const { messages, ...decision } = meta;
              if (usageEnabled()) recordUsage(
                usageRecord({
                  usage,
                  status: up.statusCode,
                  fallbackTtl: snapshot?.fallbackTtl,
                  ...decision,
                }),
              );
              release();
            });
          }
          up.on("aborted", () => { log("upstream response aborted"); release(); res.destroy(); });
          up.on("error", (err) => { log(`upstream response failed: ${err.message}`); release(); res.destroy(); });
          if (!capture) up.on("end", release);
          up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        release();
        debug(`upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}
