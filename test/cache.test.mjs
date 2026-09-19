import test from "node:test";
import assert from "node:assert/strict";
import { snapshotRequest, observeCache, estimateInput, episodeCost } from "../src/cache.mjs";

const body = () => ({
  model: "claude-sonnet-5",
  tools: [{ name: "Read", input_schema: { type: "object" } }],
  system: [{ type: "text", text: "s".repeat(16000), cache_control: { type: "ephemeral", ttl: "1h" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "task".repeat(1000), cache_control: { type: "ephemeral" } }] }],
});
const usage = (snapshot, overrides = {}) => ({
  model: snapshot.model, input: 0, cacheRead: 0, cacheCreate: snapshot.tokens,
  output: 10, advisors: [], valid: true, complete: true, ...overrides,
});

test("context estimates include system and tool definitions", () => {
  const request = body();
  const snap = snapshotRequest(request);
  assert.ok(snap.tokens > 5000);
  request.tools[0].description = "x".repeat(8000);
  assert.ok(snapshotRequest(request).tokens > snap.tokens + 1900);
});

test("matching prefixes survive appended messages and moved breakpoints", () => {
  const request = body();
  const first = snapshotRequest(request);
  const state = {};
  observeCache(state, first, usage(first), 200, 1000);
  delete request.messages[0].content[0].cache_control;
  request.messages.push({ role: "assistant", content: "done" },
    { role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] });
  const next = snapshotRequest(request);
  assert.equal(estimateInput(state, next, 2000).read, first.tokens);
  assert.ok(estimateInput(state, next, 2000).cacheable > first.tokens);
});

test("mixed TTL preserves only the hour prefix after five minutes", () => {
  const request = body();
  const snap = snapshotRequest(request);
  const state = {};
  observeCache(state, snap, usage(snap), 200, 0);
  const later = estimateInput(state, snap, 300000);
  assert.ok(later.read > 0 && later.read < snap.tokens);
  assert.equal(estimateInput(state, snap, 3600000).read, 0);
});

test("TTL starts at request start, and a read refreshes it", () => {
  const snap = snapshotRequest(body());
  const state = {};
  observeCache(state, snap, usage(snap), 200, 1000);
  observeCache(state, snap, usage(snap, { cacheRead: snap.tokens, cacheCreate: 0 }), 200, 250000);
  assert.equal(estimateInput(state, snap, 500000).read, snap.tokens);
});

test("failure, truncation and served-model mismatch do not warm a cache", () => {
  const snap = snapshotRequest(body());
  for (const [status, overrides] of [[500, {}], [200, { complete: false }], [200, { valid: false }],
    [200, { model: "claude-opus-5" }]]) {
    const state = {};
    assert.equal(observeCache(state, snap, usage(snap, overrides), status, 0), false);
    assert.equal(state.cache, undefined);
  }
});

test("changes to tools, model, effort and headers invalidate earlier prefixes", () => {
  const original = body();
  const snap = snapshotRequest(original);
  const state = {};
  observeCache(state, snap, usage(snap), 200, 0);
  for (const modify of [
    (b) => { b.tools[0].name = "Other"; },
    (b) => { b.model = "claude-opus-5"; },
    (b) => { b.output_config = { effort: "high" }; },
  ]) {
    const request = structuredClone(original);
    modify(request);
    assert.equal(estimateInput(state, snapshotRequest(request), 1000).read, 0);
  }
  assert.equal(estimateInput(state, snapshotRequest(original, { "anthropic-beta": "different" }), 1000).read, 0);
});

test("returning model reads an older prefix, not unseen subsequent messages", () => {
  const request = body();
  const snap = snapshotRequest(request);
  const state = {};
  observeCache(state, snap, usage(snap), 200, 0);
  request.messages.push({ role: "assistant", content: "new".repeat(2000) },
    { role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] });
  const next = estimateInput(state, snapshotRequest(request), 1000);
  assert.equal(next.read, snap.tokens);
  assert.ok(next.cacheable > next.read);
});

test("unknown resumed incumbent is assumed warm but fresh worker is not", () => {
  const snap = snapshotRequest(body());
  assert.ok(estimateInput({}, snap, 0, { incumbent: true, hasHistory: true }).read > 0);
  assert.equal(estimateInput({}, snap, 0, { incumbent: false, hasHistory: true }).read, 0);
  assert.equal(estimateInput({}, snap, 0, { incumbent: true, hasHistory: false }).read, 0);
});

test("late old responses cannot rewind cache expiry", () => {
  const snap = snapshotRequest(body());
  const state = {};
  observeCache(state, snap, usage(snap), 200, 10000);
  observeCache(state, snap, usage(snap), 200, 0);
  assert.equal(estimateInput(state, snap, 305000).read, snap.tokens);
});

test("short Haiku prompts are charged as uncached input", () => {
  const request = body();
  request.model = "claude-haiku-4-5-20251001";
  request.system = "short";
  request.messages = [{ role: "user", content: "hi" }];
  request.cache_control = { type: "ephemeral" };
  const input = estimateInput({}, snapshotRequest(request), 0);
  assert.equal(input.cacheable, 0);
  assert.equal(episodeCost(input, { requests: 1, output: 10, growth: 0 }),
    (input.tokens + 50) / 1e6);
});

test("cost examples distinguish short versus multi-request episodes", () => {
  const base = { tokens: 80000, cacheable: 80000, read: 80000, oneHour: 0, ttl: "5m", minimum: 512, supported: true };
  const sonnet = { ...base, model: "claude-sonnet-5" };
  const haiku = { ...base, model: "claude-haiku-4-5-20251001", read: 0 };
  const short = { requests: 1, output: 200, growth: 0 };
  assert.equal(episodeCost(sonnet, short), 0.018);
  assert.equal(episodeCost(haiku, short), 0.101);
  const long = { requests: 10, output: 10000, growth: 0 };
  assert.ok(episodeCost(haiku, long) < episodeCost(sonnet, long));
});
