import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { startProxy, conversationKey } from "../src/proxy.mjs";
import { snapshotRequest } from "../src/cache.mjs";

const sure = (choice, workload = "short") => ({ choice, confidence: 0.95,
  workload: { choice: workload, confidence: 0.95 },
  contextDependence: { choice: "standalone", confidence: 0.95 } });
const request = (session = "integration") => ({
  model: "jev-auto", stream: true,
  metadata: { user_id: JSON.stringify({ session_id: session }) },
  tools: [{ name: "Read", input_schema: { type: "object" } }],
  system: [{ type: "text", text: "context ".repeat(40000), cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "Explain this repository" }],
});
const next = (body, prompt) => ({ ...body, messages: [...body.messages,
  { role: "assistant", content: "Previous answer" }, { role: "user", content: prompt }] });

async function harness(t, { answers = [], compressed = false, failAt = -1, routeError = false } = {}) {
  const sent = [];
  const judgments = [];
  const statuses = [];
  let clock = 1000000;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      sent.push(body);
      if (sent.length === failAt) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end('{"error":{"message":"temporarily unavailable"}}');
        return;
      }
      const snap = snapshotRequest(body);
      const usage = { input_tokens: 10, cache_creation_input_tokens: snap.checkpoints.at(-1)?.tokens ?? 0,
        cache_read_input_tokens: 0, output_tokens: 1 };
      const text = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: body.model, usage } })}\n\n` +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":100}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n';
      res.writeHead(200, { "content-type": "text/event-stream", ...(compressed ? { "content-encoding": "gzip" } : {}) });
      const bytes = compressed ? gzipSync(text) : Buffer.from(text);
      res.write(bytes.subarray(0, 17));
      res.end(bytes.subarray(17));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await startProxy({
    now: () => clock,
    publish: (_, status) => statuses.push(status),
    route: async (input) => {
      judgments.push(input);
      if (routeError) throw new Error("test router unavailable");
      return answers.shift() ?? sure("sonnet");
    },
    upstreamRequest: (options, cb) => http.request({ ...options, hostname: "127.0.0.1", port: upstream.address().port }, cb),
  });
  t.after(async () => {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  });
  return { sent, judgments, statuses, advance: (ms) => { clock += ms; },
    async send(body, path = "/v1/messages") {
      const response = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, text };
    },
  };
}

test("real proxy uses response cache evidence without JEV_USAGE; pins tool loops and retries", async (t) => {
  const h = await harness(t, { answers: [sure("opus"), sure("haiku")] });
  const first = request();
  await h.send(first);
  await h.send(first);
  assert.equal(h.judgments.length, 1, "retry shares the original decision");
  const tool = { ...first, messages: [...first.messages,
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "text" }] }] };
  await h.send(tool);
  assert.equal(h.judgments.length, 1);
  await h.send(next(first, "Summarize the changes in one sentence"));
  assert.equal(h.sent.at(-1).model, "claude-opus-5");
  assert.match(h.statuses.at(-1).reason, /cache-rebuild/);
  assert.ok(h.judgments[0].contextTokens > 80000, "system/tools included");
});

test("expiry removes incumbent cache advantage and permits a cheaper model", async (t) => {
  const h = await harness(t, { answers: [sure("opus"), sure("haiku")] });
  const first = request("expiry");
  await h.send(first);
  h.advance(300001);
  await h.send(next(first, "Print a short factual answer"));
  assert.equal(h.sent.at(-1).model, "claude-haiku-4-5-20251001");
  assert.equal(h.statuses.at(-1).reason, "episode-savings");
});

test("compressed upstream responses still feed cache evidence and forward intact", async (t) => {
  const h = await harness(t, { compressed: true, answers: [sure("opus"), sure("haiku")] });
  const first = request("compressed");
  const result = await h.send(first);
  assert.match(result.text, /message_stop/);
  await h.send(next(first, "Provide a short summary"));
  assert.equal(h.sent.at(-1).model, "claude-opus-5");
  assert.match(h.statuses.at(-1).reason, /cache-rebuild/);
});

test("manual requests are not routed and manual cache warms future auto mode", async (t) => {
  const h = await harness(t, { answers: [sure("haiku")] });
  const first = { ...request("manual"), model: "claude-opus-5" };
  await h.send(first);
  assert.equal(h.judgments.length, 0);
  assert.equal(h.sent[0].model, "claude-opus-5");
  await h.send({ ...next(first, "Summarize the outcome"), model: "jev-auto" });
  assert.equal(h.judgments[0].current, "opus");
  assert.equal(h.sent.at(-1).model, "claude-opus-5");
});

test("fresh workers route separately and do not alter parent pinning", async (t) => {
  const h = await harness(t, { answers: [sure("opus"), sure("haiku")] });
  const parent = request("agents");
  await h.send(parent);
  const child = { ...parent, system: "small worker", messages: [{ role: "user", content: "Fix one typo" }] };
  await h.send(child);
  assert.equal(h.sent.at(-1).model, "claude-haiku-4-5-20251001");
  await h.send(next(parent, "continue"));
  assert.equal(h.sent.at(-1).model, "claude-opus-5");
});

test("explicit agent metadata separates forks with identical opening context", () => {
  const parent = request();
  const child = { ...parent, metadata: { ...parent.metadata, agent_id: "worker1" } };
  assert.notEqual(conversationKey(parent), conversationKey(child));
});

test("routing outage keeps a real model and never sends the sentinel", async (t) => {
  const h = await harness(t, { routeError: true });
  await h.send(request("outage"));
  assert.equal(h.sent[0].model, "claude-sonnet-5");
  assert.match(h.statuses.at(-1).reason, /jev-unavailable/);
});

test("count_tokens and auxiliary manual calls never consult Jev", async (t) => {
  const h = await harness(t);
  await h.send({ model: "claude-sonnet-5", messages: [{ role: "user", content: "title" }] });
  await h.send({ ...request("count"), model: "claude-sonnet-5" }, "/v1/messages/count_tokens");
  assert.equal(h.judgments.length, 0);
});
