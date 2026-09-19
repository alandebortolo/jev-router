/**
 * Runs the shipped router and policy over each task and records what Jev would have chosen.
 *
 *   node bench/agentic/decide.mjs [--tasks tasks.jsonl] [--concurrency 8]
 *
 * This imports src/router.mjs and src/policy.mjs directly, so it measures the code that
 * actually ships rather than a reimplementation of it.
 *
 * Context size is taken from the measured replay rather than assumed, because the downgrade
 * guard is a function of it: a first turn in a real repository already carries tens of
 * thousands of tokens of system prompt and tool schemas, which is well past the threshold at
 * which the policy refuses to rebuild the prompt cache.
 */
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// The launcher loads these before starting the proxy; a script that imports the router
// directly has to do the same, or every call fails for want of a key -- and a Jev failure is
// recorded as "kept sonnet", which looks like a decision rather than an outage.
for (const f of [join(homedir(), ".jev-claude.env"), join(process.cwd(), ".env")]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* missing; the key may still come from the environment */
  }
}
if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) {
  console.error("no JEV_API_KEY / TYPESAFE_API_KEY; decisions would all be failures");
  process.exit(1);
}

const { askJev } = await import("../../src/router.mjs");
const { decide } = await import("../../src/policy.mjs");
const { availableTiers, TIERS } = await import("../../src/config.mjs");

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : process.argv[i + 1];
};
const here = import.meta.dirname;
const TASKS = arg("--tasks", join(here, "data", "tasks.jsonl"));
const REPLAYS = arg("--replays", join(here, "data", "replays.jsonl"));
const OUT = arg("--out", join(here, "data", "decisions.jsonl"));
const CONC = Number(arg("--concurrency", 8));

const readJsonl = (f) =>
  existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// Context size is the first routed request of a replay, recorded by the proxy ledger. Both
// tiers see the same prompt, so the smaller of the two is used: it is the one not inflated by
// a retry or a longer tool loop.
const ctxByTask = new Map();
for (const r of readJsonl(REPLAYS)) {
  if (!r.contextTokens) continue;
  const prev = ctxByTask.get(r.task);
  ctxByTask.set(r.task, prev == null ? r.contextTokens : Math.min(prev, r.contextTokens));
}

const done = new Set(readJsonl(OUT).map((d) => d.task));
const queue = readJsonl(TASKS).filter((t) => t.keep === true && !done.has(t.id));
const available = availableTiers();

/**
 * `decide()` takes per-tier cost snapshots, not a raw token count, and refuses every
 * downgrade as "cost-unavailable" when they are missing -- which silently turns the shipped
 * policy into always-stay. These reconstruct the shape `estimateInput()` returns in the
 * proxy, from the context size actually measured during the replay.
 *
 * The incumbent is warm and the target is cold, which is the real situation a downgrade
 * faces: the prompt cache has to be rebuilt on the tier being switched to. That asymmetry is
 * the entire question the policy is weighing, so flattening it would beg it.
 */
const costFor = (name, contextTokens, warm) => {
  const spec = TIERS.find((t) => t.name === name);
  if (!spec) return null;
  const cacheable = contextTokens >= spec.minCacheTokens ? contextTokens : 0;
  return {
    model: spec.id,
    tokens: contextTokens,
    cacheable,
    read: warm ? cacheable : 0,
    oneHour: 0,
    ttl: "5m",
    unknown: false,
    supported: true,
    minimum: spec.minCacheTokens,
  };
};

console.log(`${queue.length} tasks to decide; tiers=${available.join(",")}`);
let n = 0;
let failed = 0;

await Promise.all(
  Array.from({ length: Math.min(CONC, queue.length) }, async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      const contextTokens = ctxByTask.get(t.id) ?? 0;
      const current = "sonnet";
      const jev = await askJev({ prompt: t.prompt, current, contextTokens, available });
      if (!jev) {
        // Not recorded: a failed call is an outage, not a decision, and recording it would
        // permanently mark the task as decided with a fabricated "kept sonnet".
        failed++;
        continue;
      }
      const { tier, reason } = decide({
        prompt: t.prompt,
        jev,
        current,
        available,
        costs: Object.fromEntries(
          available.map((name) => [name, costFor(name, contextTokens, name === current)]),
        ),
      });
      appendFileSync(
        OUT,
        JSON.stringify({
          task: t.id,
          contextTokens,
          jevTier: jev.choice,
          confidence: jev.confidence,
          ms: jev.ms,
          tier,
          reason,
        }) + "\n",
      );
      n++;
    }
  }),
);
console.log(`decided ${n} (${failed} Jev failures) -> ${OUT}`);
