/**
 * Scores Jev's decisions against the judge labels.
 *
 *   node bench/agentic/score.mjs [--cheap haiku] [--strong opus] [--boot 5000]
 *
 * Two things are reported and they answer different questions.
 *
 * Ranking quality (AUC) asks whether Jev orders tasks by how much escalation is worth. It is
 * threshold-free and is the honest measure of the signal.
 *
 * The policy table asks what the shipped thresholds actually cost and save, using the measured
 * dollar cost of the replays that really ran. Every alternative policy is evaluated on the
 * same tasks with the same measured costs, so the comparison is like-for-like.
 *
 * The comparison that matters is not against always-strong but against random escalation at
 * the same rate. A router that escalates 40% of the time will beat never-escalating; the
 * question is whether it beats flipping a weighted coin, and that is the baseline a previous
 * RouterBench run showed a headline number can hide.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : process.argv[i + 1];
};
const here = import.meta.dirname;
const CHEAP = arg("--cheap", "haiku");
const STRONG = arg("--strong", "opus");
const BOOT = Number(arg("--boot", 5000));

const readJsonl = (f) =>
  existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const d = (n) => join(here, "data", n);

const tasks = new Map(readJsonl(d("tasks.jsonl")).map((t) => [t.id, t]));
const decisions = new Map(readJsonl(d("decisions.jsonl")).map((x) => [x.task, x]));
const verdicts = new Map(readJsonl(d("verdicts.jsonl")).map((v) => [v.task, v]));
const replays = new Map();
for (const r of readJsonl(d("replays.jsonl"))) {
  if (!r.ok || !r.tierVerified) continue;
  const e = replays.get(r.task) ?? {};
  e[r.tier] = r;
  replays.set(r.task, e);
}

// Escalation score. Jev returns a tier plus a confidence; a single number is needed to ask
// whether it *ranks* tasks correctly. Confidence is signed by the direction of the choice, so
// a confident "haiku" ranks below an unsure "haiku" and a confident "opus" above an unsure one.
const RANK = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
const escalationScore = (dec) => {
  if (!dec || dec.jevTier == null) return null;
  const r = RANK[dec.jevTier] ?? 1;
  const c = dec.confidence ?? 0.5;
  return r + (r >= RANK[STRONG] ? c : -c) * 0.49;
};

const rows = [];
for (const [id, v] of verdicts) {
  const rep = replays.get(id);
  const dec = decisions.get(id);
  if (!rep?.[CHEAP] || !rep?.[STRONG] || !dec) continue;
  if (v.winner === "failed") continue;
  rows.push({
    id,
    prompt: tasks.get(id)?.prompt ?? "",
    source: tasks.get(id)?.source ?? "harvested",
    difficultyHint: tasks.get(id)?.difficultyHint ?? null,
    // "unstable" means the two orderings disagreed, which is evidence of no material
    // difference rather than evidence of one, so it is folded in with ties.
    worth: v.winner === "strong",
    unstable: v.winner === "unstable",
    cheapWon: v.winner === "cheap",
    score: escalationScore(dec),
    jevTier: dec.jevTier,
    policyTier: dec.tier,
    reason: dec.reason,
    costCheap: rep[CHEAP].cost ?? 0,
    costStrong: rep[STRONG].cost ?? 0,
    turnsCheap: rep[CHEAP].turns,
    turnsStrong: rep[STRONG].turns,
  });
}

if (!rows.length) {
  console.log("no scorable tasks; run harvest -> replay -> judge -> decide first");
  process.exit(0);
}

const n = rows.length;
const worth = rows.filter((r) => r.worth).length;
console.log(`# corpus\n`);
console.log(`scorable tasks          ${n}`);
console.log(`escalation was worth it ${worth} (${((worth / n) * 100).toFixed(0)}%)`);
console.log(`cheap answer won        ${rows.filter((r) => r.cheapWon).length}`);
console.log(`position-unstable       ${rows.filter((r) => r.unstable).length}`);
for (const src of [...new Set(rows.map((r) => r.source))]) {
  const s = rows.filter((r) => r.source === src);
  console.log(`  ${src.padEnd(20)} ${String(s.length).padStart(3)} tasks, ${s.filter((r) => r.worth).length} worth escalating`);
}

// If the generator was asked for a difficulty range and its own labels do not predict whether
// escalation helped, the corpus has no range and nothing downstream means anything.
const hinted = rows.filter((r) => r.difficultyHint);
if (hinted.length) {
  console.log(`\ngenerator difficulty label vs measured escalation value:`);
  for (const lvl of ["easy", "medium", "hard"]) {
    const s = hinted.filter((r) => r.difficultyHint === lvl);
    if (s.length) console.log(`  ${lvl.padEnd(8)} ${String(s.length).padStart(3)} tasks, ${((s.filter((r) => r.worth).length / s.length) * 100).toFixed(0)}% worth escalating`);
  }
}

// --- ranking quality -------------------------------------------------------------------
const auc = (scored) => {
  const pos = scored.filter((r) => r.worth).map((r) => r.s);
  const neg = scored.filter((r) => !r.worth).map((r) => r.s);
  if (!pos.length || !neg.length) return null;
  let sum = 0;
  for (const p of pos) for (const q of neg) sum += p > q ? 1 : p === q ? 0.5 : 0;
  return sum / (pos.length * neg.length);
};

const signals = {
  jev: rows.filter((r) => r.score != null).map((r) => ({ worth: r.worth, s: r.score })),
  "prompt length": rows.map((r) => ({ worth: r.worth, s: r.prompt.length })),
  "cheap turn count": rows.map((r) => ({ worth: r.worth, s: r.turnsCheap ?? 0 })),
};

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const bootAuc = (scored) => {
  const rand = rng(7);
  const out = [];
  for (let b = 0; b < BOOT; b++) {
    const s = Array.from({ length: scored.length }, () => scored[Math.floor(rand() * scored.length)]);
    const a = auc(s);
    if (a != null) out.push(a);
  }
  out.sort((x, y) => x - y);
  return out.length ? [out[Math.floor(out.length * 0.025)], out[Math.floor(out.length * 0.975)]] : null;
};

console.log(`\n# does the signal rank tasks by escalation value?  (0.5 = no signal)\n`);
for (const [name, scored] of Object.entries(signals)) {
  const a = auc(scored);
  if (a == null) {
    console.log(`${name.padEnd(18)} n/a (one class empty)`);
    continue;
  }
  const ci = bootAuc(scored);
  console.log(`${name.padEnd(18)} AUC ${a.toFixed(3)}  95% CI [${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]`);
}

const sources = [...new Set(rows.map((r) => r.source))];
if (sources.length > 1) {
  console.log(`\njev AUC by corpus source (pooling these would hide generator bias):`);
  for (const src of sources) {
    const s = rows.filter((r) => r.source === src && r.score != null).map((r) => ({ worth: r.worth, s: r.score }));
    const a = auc(s);
    console.log(`  ${src.padEnd(12)} ${a == null ? "n/a (one class empty)" : `AUC ${a.toFixed(3)}  (n=${s.length})`}`);
  }
}

// --- policies --------------------------------------------------------------------------
const evaluate = (name, picksStrong) => {
  let cost = 0;
  let regret = 0;
  let waste = 0;
  let escalations = 0;
  for (const r of rows) {
    const strong = picksStrong(r);
    if (strong) escalations++;
    cost += strong ? r.costStrong : r.costCheap;
    if (!strong && r.worth) regret++;
    if (strong && !r.worth) waste++;
  }
  return { name, cost, regret, waste, escalations, quality: (n - regret) / n };
};

const jevRate = rows.filter((r) => r.policyTier !== CHEAP).length / n;
const rand = rng(11);
const randomPicks = new Map(rows.map((r) => [r.id, rand() < jevRate]));
const lenCut = [...rows].sort((a, b) => b.prompt.length - a.prompt.length)[Math.max(0, Math.round(jevRate * n) - 1)];

const policies = [
  evaluate("jev (shipped)", (r) => r.policyTier !== CHEAP),
  evaluate("jev (raw tier)", (r) => r.jevTier !== CHEAP),
  evaluate(`random @ ${(jevRate * 100).toFixed(0)}%`, (r) => randomPicks.get(r.id)),
  evaluate(`length @ ${(jevRate * 100).toFixed(0)}%`, (r) => r.prompt.length >= (lenCut?.prompt.length ?? Infinity)),
  evaluate("always cheap", () => false),
  evaluate("always strong", () => true),
  evaluate("oracle (quality)", (r) => r.worth),
  evaluate("oracle (qual+cost)", (r) => r.worth || r.costStrong < r.costCheap),
];

const alwaysStrong = policies.find((p) => p.name === "always strong").cost;
console.log(`\n# what each policy costs and keeps  (measured replay cost, n=${n})\n`);
console.log("policy                 escalated     cost   vs always-strong   quality   regret  waste");
for (const p of policies) {
  console.log(
    `${p.name.padEnd(22)} ${String(p.escalations).padStart(9)} ${("$" + p.cost.toFixed(3)).padStart(8)} ` +
      `${(((p.cost / alwaysStrong - 1) * 100).toFixed(0) + "%").padStart(18)} ` +
      `${((p.quality * 100).toFixed(0) + "%").padStart(9)} ${String(p.regret).padStart(8)} ${String(p.waste).padStart(6)}`,
  );
}

console.log(
  `\nquality = share of tasks where the chosen tier was not materially worse.` +
    `\nregret  = cheap was chosen but the strong answer was materially better.` +
    `\nwaste   = strong was chosen but bought nothing.`,
);

// Downgrading is not automatically cheaper: a weak model that flails burns more turns, and
// more turns on a cheap model can cost more than a few turns on an expensive one. If this
// share is high, the premise of cost-saving routing is in trouble on agentic work.
const cheapCostsMore = rows.filter((r) => r.costCheap > r.costStrong).length;
const ratio = rows.reduce((a, r) => a + r.costCheap, 0) / rows.reduce((a, r) => a + r.costStrong, 0);
console.log(
  `\ncheap tier cost MORE than strong on ${cheapCostsMore}/${n} tasks ` +
    `(${((cheapCostsMore / n) * 100).toFixed(0)}%); all-cheap is ${((1 - ratio) * 100).toFixed(0)}% cheaper overall`,
);

// The only comparison that can falsify the router: does it beat a coin weighted to escalate
// just as often? Repeated draws, because a single random assignment is noise.
const boots = [];
for (let b = 0; b < BOOT; b++) {
  const rr = rng(1000 + b);
  let q = 0;
  for (const r of rows) if (!(rr() < jevRate) && r.worth) q++;
  boots.push((n - q) / n);
}
boots.sort((a, b) => a - b);
const jevQ = policies[0].quality;
const better = boots.filter((q) => q >= jevQ).length / boots.length;
console.log(
  `\n# vs random at the same escalation rate\n\n` +
    `jev quality            ${(jevQ * 100).toFixed(1)}%\n` +
    `random quality  median ${(boots[Math.floor(boots.length / 2)] * 100).toFixed(1)}%  ` +
    `95% CI [${(boots[Math.floor(boots.length * 0.025)] * 100).toFixed(1)}%, ${(boots[Math.floor(boots.length * 0.975)] * 100).toFixed(1)}%]\n` +
    `P(random >= jev)       ${better.toFixed(3)}${better > 0.05 ? "   <- not distinguishable from random" : ""}`,
);
