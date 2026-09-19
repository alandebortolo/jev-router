import { test } from "node:test";
import assert from "node:assert/strict";
import { priceOf, costOf } from "../src/pricing.mjs";
import { parseUsage, usageRecord, createUsageCollector } from "../src/usage.mjs";

test("prices the current model line", () => {
  assert.equal(priceOf("claude-haiku-4-5-20251001").input, 1);
  assert.equal(priceOf("claude-sonnet-5").input, 2);
  assert.equal(priceOf("claude-sonnet-4-6").input, 3);
  assert.equal(priceOf("claude-opus-5").input, 5);
  assert.equal(priceOf("claude-opus-4-6").input, 5);
});

test("retired Opus 4.0/4.1 keep their higher price, not Opus 5's", () => {
  assert.equal(priceOf("claude-opus-4-1-20250805").input, 15);
  assert.equal(priceOf("claude-opus-4-20250514").input, 15);
});

test("Fable 5.1 has the cheaper cache read", () => {
  assert.equal(priceOf("claude-fable-5-1").cacheRead, 0.25);
  assert.equal(priceOf("claude-fable-5").cacheRead, 1);
});

test("unknown model yields no price and no cost", () => {
  assert.equal(priceOf("jev-auto"), null);
  assert.equal(priceOf(undefined), null);
  assert.equal(costOf("gpt-4", { input: 100 }), null);
});

test("costs the four token classes separately", () => {
  // Cache creation is 1.25x input and cache read 0.1x, which is what makes a model switch
  // expensive; a blended per-token rate would hide it.
  const cost = costOf("claude-sonnet-5", {
    input: 1_000_000,
    cacheCreate: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000,
  });
  assert.equal(cost, 2 + 2.5 + 0.2 + 10);
});

test("parses usage from a streaming response", () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-haiku-4-5-20251001","usage":{"input_tokens":12,"cache_read_input_tokens":900,"cache_creation_input_tokens":40,"output_tokens":1}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":57}}',
    '',
  ].join("\n");
  const u = parseUsage(sse);
  assert.equal(u.model, "claude-haiku-4-5-20251001");
  assert.equal(u.input, 12);
  assert.equal(u.cacheRead, 900);
  assert.equal(u.cacheCreate, 40);
  // message_delta carries the final total, message_start only the first token.
  assert.equal(u.output, 57);
});

test("parses usage from a non-streaming response", () => {
  const u = parseUsage(JSON.stringify({
    model: "claude-opus-5",
    usage: { input_tokens: 5, output_tokens: 9 },
  }));
  assert.equal(u.model, "claude-opus-5");
  assert.equal(u.output, 9);
  assert.equal(u.cacheRead, 0);
});

test("returns null for bodies with no usage", () => {
  assert.equal(parseUsage(""), null);
  assert.equal(parseUsage("not json"), null);
  assert.equal(parseUsage(null), null);
});

test("survives a truncated stream", () => {
  const u = parseUsage(
    'data: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":7}}}\ndata: {"type":"mess',
  );
  assert.equal(u.model, "claude-sonnet-5");
  assert.equal(u.input, 7);
});

test("ledger row carries the decision alongside the tokens", () => {
  const row = usageRecord({
    text: JSON.stringify({ model: "claude-haiku-4-5-20251001", usage: { input_tokens: 1000, output_tokens: 2000 } }),
    status: 200,
    requested: "jev-auto",
    tier: "haiku",
    reason: "jev",
    routed: true,
    session: "s1",
    key: "abc123",
  });
  assert.equal(row.routed, true);
  assert.equal(row.requested, "jev-auto");
  assert.equal(row.served, "claude-haiku-4-5-20251001");
  assert.equal(row.tier, "haiku");
  assert.equal(row.cost, (1000 * 1 + 2000 * 5) / 1e6);
});

test("ledger row records an unpriced model as null cost, not zero", () => {
  const row = usageRecord({ text: '{"model":"mystery-1","usage":{"input_tokens":5}}', status: 200, routed: false });
  assert.equal(row.served, "mystery-1");
  assert.equal(row.cost, null);
});

test("mixed cache TTLs are billed without double counting", () => {
  const row = usageRecord({ status: 200, text: JSON.stringify({
    model: "claude-sonnet-5", usage: { cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 } },
  }) });
  assert.equal(row.cacheCreate1h, 600);
  assert.equal(row.cost, (400 * 2.5 + 600 * 4) / 1e6);
  assert.equal(row.costEstimated, false);
});

test("advisor iterations add their own rates without duplicating executor totals", () => {
  const row = usageRecord({ status: 200, text: JSON.stringify({
    model: "claude-sonnet-5",
    usage: { input_tokens: 1000, output_tokens: 200, iterations: [
      { type: "message", input_tokens: 1000, output_tokens: 200 },
      { type: "advisor_message", model: "claude-opus-5", input_tokens: 3000, output_tokens: 1000 },
    ] },
  }) });
  assert.equal(row.executorCost, 0.004);
  assert.equal(row.advisorCost, 0.04);
  assert.equal(row.cost, 0.044);
});

test("unknown advisor prices propagate unknown total cost", () => {
  const row = usageRecord({ text: JSON.stringify({ model: "claude-sonnet-5",
    usage: { iterations: [{ type: "advisor_message", model: "unknown", input_tokens: 1 }] } }) });
  assert.equal(row.cost, null);
});

test("incremental accounting handles arbitrary UTF-8 and SSE chunk boundaries", () => {
  const text = 'event: message_start\r\ndata: {"message":{"model":"claude-sonnet-5","usage":{"input_tokens":42}}}\r\n\r\n' +
    'event: content_block_delta\ndata: {"delta":{"text":"caf\\u00e9"}}\n\n' +
    'data: {"type":"message_delta","usage":{"output_tokens":23}}\n\ndata: {"type":"message_stop"}\n\n';
  const collector = createUsageCollector();
  for (const byte of Buffer.from(text)) collector.write(Buffer.from([byte]));
  const u = collector.finish();
  assert.equal(u.input, 42);
  assert.equal(u.output, 23);
  assert.equal(u.complete, true);
});

test("negative or nonnumeric usage produces unknown cost", () => {
  for (const input_tokens of [-1, "100", 0.5]) {
    const row = usageRecord({ text: JSON.stringify({ model: "claude-sonnet-5", usage: { input_tokens } }) });
    assert.equal(row.cost, null);
  }
});

test("hour fallback is labeled as estimated when provider omits TTL detail", () => {
  const row = usageRecord({ fallbackTtl: "1h",
    text: '{"model":"claude-sonnet-5","usage":{"cache_creation_input_tokens":1000}}' });
  assert.equal(row.cost, 0.004);
  assert.equal(row.costEstimated, true);
});
