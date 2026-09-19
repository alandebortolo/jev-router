import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride } from "../src/policy.mjs";
import { TIERS } from "../src/config.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
const sure = (choice, workload = "short") => ({ choice, confidence: 0.95,
  workload: { choice: workload, confidence: 0.95 },
  contextDependence: { choice: "standalone", confidence: 0.95 } });
const unsure = (choice) => ({ choice, confidence: 0.3 });
const base = { prompt: "refactor the parser", current: "sonnet", available: ALL, contextTokens: 0 };
const costs = (tokens, warm = [], ttl = "5m") => Object.fromEntries(TIERS.map((t) => [t.name, {
  model: t.id, tokens, cacheable: tokens, read: warm.includes(t.name) ? tokens : 0,
  oneHour: ttl === "1h" ? tokens : 0, ttl, minimum: t.minCacheTokens, supported: true,
}]));

test("follows a confident Jev answer", () => {
  assert.deepEqual(decide({ ...base, jev: sure("opus") }), {
    tier: "opus",
    reason: "jev",
    changed: true,
  });
});

test("an explicit user override beats Jev", () => {
  const out = decide({ ...base, prompt: "use haiku to fix this typo", jev: sure("opus") });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

test("detectOverride only fires on a real instruction", () => {
  assert.equal(detectOverride("switch to opus"), "opus");
  assert.equal(detectOverride("the opus of his career"), null);
});

test("keeps the current model when Jev is unreachable", () => {
  const out = decide({ ...base, jev: null });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.changed, false);
  assert.match(out.reason, /jev-unavailable/);
});

test("ignores a tier name Jev invented", () => {
  assert.equal(decide({ ...base, jev: sure("gpt-9") }).tier, "sonnet");
});

test("never downgrades on a low-confidence answer", () => {
  const out = decide({ ...base, jev: unsure("haiku") });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /low-confidence-no-downgrade/);
});

test("caps a low-confidence upgrade at the safe ceiling", () => {
  const out = decide({ ...base, current: "haiku", jev: unsure("fable") });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.reason, "low-confidence-capped");
});

test("still allows a confident upgrade to fable", () => {
  assert.equal(decide({ ...base, jev: sure("fable") }).tier, "fable");
});

test("refuses a downgrade once the cache rebuild costs more than it saves", () => {
  const out = decide({ ...base, current: "opus", jev: sure("haiku"), costs: costs(80000, ["opus"]) });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /cache-rebuild/);
});

test("allows the same downgrade early in a conversation", () => {
  assert.equal(decide({ ...base, current: "opus", jev: sure("haiku"), costs: costs(5000) }).tier, "haiku");
});

test("a cold long conversation can downgrade without a size cutoff", () => {
  assert.equal(decide({ ...base, jev: sure("haiku"), costs: costs(200000) }).tier, "haiku");
});

test("large warm context can repay a switch within one bounded task", () => {
  const out = decide({ ...base, current: "opus", jev: sure("haiku", "bounded"), costs: costs(80000, ["opus"]) });
  assert.equal(out.tier, "haiku");
  assert.ok(out.estimate.scenarios.every((s) => s.switch <= s.stay * 0.8));
});

test("one-hour writes can reverse a five-minute downgrade decision", () => {
  const input = { ...base, current: "opus", jev: sure("haiku", "bounded") };
  assert.equal(decide({ ...input, costs: costs(80000, ["opus"]) }).tier, "haiku");
  assert.equal(decide({ ...input, costs: costs(80000, ["opus"], "1h") }).tier, "opus");
});

test("unknown costs never justify a downgrade, but do not block a quality upgrade", () => {
  assert.match(decide({ ...base, jev: sure("haiku") }).reason, /cost-unavailable/);
  assert.equal(decide({ ...base, jev: sure("opus") }).tier, "opus");
});

test("unpriced candidates never look free", () => {
  const c = costs(10000);
  c.haiku.model = "unknown";
  assert.equal(decide({ ...base, jev: sure("haiku"), costs: c }).tier, "sonnet");
});

test("uncertain workload must repay even a one-request episode", () => {
  const jev = sure("haiku", "bounded");
  jev.workload.confidence = 0.2;
  const out = decide({ ...base, current: "opus", jev, costs: costs(80000, ["opus"]) });
  assert.equal(out.tier, "opus");
  assert.equal(out.estimate.workload, "uncertain");
});

test("short approvals inherit capability even if Jev calls them standalone", () => {
  for (const prompt of ["continue", "yes", "implement that", "do it please"]) {
    const out = decide({ ...base, prompt, current: "opus", hasHistory: true,
      jev: sure("haiku"), costs: costs(5000) });
    assert.equal(out.tier, "opus", prompt);
    assert.match(out.reason, /context-dependent/);
  }
});

test("dependent or missing context judgment blocks only downgrades", () => {
  for (const contextDependence of [undefined, { choice: "dependent", confidence: 0.95 }]) {
    const input = { ...base, hasHistory: true, costs: costs(5000) };
    assert.equal(decide({ ...input, jev: { ...sure("haiku"), contextDependence } }).tier, "sonnet");
    assert.equal(decide({ ...input, jev: { ...sure("opus"), contextDependence } }).tier, "opus");
  }
});

test("malformed confidence is not treated as high confidence", () => {
  for (const confidence of [undefined, NaN, Infinity, -1, 1.1, "0.99"]) {
    assert.equal(decide({ ...base, jev: { choice: "opus", confidence } }).tier, "sonnet");
  }
});

test("availability is resolved before estimating a downgrade", () => {
  const out = decide({ ...base, current: "opus", available: ["sonnet", "opus"],
    jev: sure("haiku"), costs: costs(80000, ["opus"]) });
  assert.equal(out.tier, "opus");
  assert.equal(out.estimate.target.model, "claude-sonnet-5");
});

test("substitutes upward when the chosen tier is unavailable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "opus"], jev: sure("sonnet") });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /unavailable/);
});

test("never substitutes upward into paid fable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "fable"], jev: sure("opus") });
  assert.equal(out.tier, "haiku");
});
