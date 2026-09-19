# Agentic evaluation: does Jev route Claude Code well?

Run 2026-09-17 to 2026-09-19. 87 tasks, 174 agentic sessions, 86 judged pairs, $59.42 of
measured model usage.

**Headline: no. On this corpus Jev's routing signal is not distinguishable from chance, and
the shipped policy never downgrades at all — because in Claude Code a downgrade almost never
pays for itself.** The second half of that sentence is the useful finding, and it is an
argument about prompt-cache economics rather than about Jev.

---

## What was measured

Each task was run twice through the real `claude` binary in its real repository — once pinned
to Haiku, once to Opus — with `--permission-mode plan` and a deny list, so the agent explored
with `Read`/`Glob`/`Grep` but changed nothing. The tier was pinned with `JEV_FORCE_TIER`,
which drives the same rewrite path the product uses, and **verified from the proxy ledger
against the model id the API echoed back: 174/174 sessions served the intended model.**

The two answers were then shown to an Opus judge, blinded and **in both orders**. A verdict
counts only when both orderings name the same answer; otherwise it is `unstable` and is
pooled with ties. The rubric asks whether one answer is *materially* better on a named,
specific difference, and explicitly excludes length, formatting, tone and confidence.

## Corpus

| | tasks | escalation was worth it |
|---|---|---|
| generated (repo-grounded, synthetic) | 71 | 50 (70%) |
| harvested (real prompts from transcripts) | 15 | 6 (40%) |
| **total** | **86** | **56 (65%)** |

Cheap won outright on 6. 10 were genuine ties. **14 of 86 (16%) were position-unstable**, so
judge stability was 84%.

The generator's own difficulty labels do not predict anything: easy 61% worth escalating,
medium 79%, hard 71%. A label that is non-monotonic across its own three levels carries no
information, so the corpus has less difficulty range than intended.

## Does the signal rank tasks by escalation value?

AUC over the 86 pairs; 0.5 is no signal.

| signal | AUC | 95% CI |
|---|---|---|
| **Jev** | **0.570** | [0.429, 0.693] |
| prompt length (free, no API call) | **0.613** | [0.469, 0.760] |
| cheap-model turn count | 0.454 | [0.323, 0.572] |

Jev's CI contains 0.5, so the null cannot be rejected. **Prompt length scores higher than
Jev.** A heuristic with no dependency, no network call and no per-request latency ranks these
tasks at least as well as the router does.

This repeats what the RouterBench run found, where `corr(escalation score, cost) = 0.71` —
Jev escalates long prompts, and long prompts are the expensive ones. Two unrelated corpora
now point the same way, which is harder to dismiss than either alone.

By source, Jev scores 0.579 on generated (n=71) and 0.731 on harvested (n=15). The harvested
figure is the more interesting one and is the best argument that the synthetic corpus is
holding the score down — but n=15 with 6 positives is far too small to lean on. During the
run it read 1.000 at n=6, 0.643 at n=11 and 0.731 at n=15; that is what noise looks like.

## What each policy would have cost

Measured replay dollars, n=86.

| policy | escalated | cost | vs always-strong | quality | regret | waste |
|---|---|---|---|---|---|---|
| jev (shipped) | 86 | $35.35 | 0% | 100% | 0 | 30 |
| jev (raw tier) | 56 | $31.60 | **−11%** | 80% | 17 | 17 |
| random @ 100% | 86 | $35.35 | 0% | 100% | 0 | 30 |
| length @ 100% | 86 | $35.35 | 0% | 100% | 0 | 30 |
| always cheap | 0 | $23.90 | −32% | 35% | 56 | 0 |
| always strong | 86 | $35.35 | 0% | 100% | 0 | 30 |
| oracle (quality) | 56 | $34.07 | −4% | 100% | 0 | 0 |
| oracle (quality + cost) | 61 | $32.58 | −8% | 100% | 0 | 5 |

*quality* = share of tasks where the chosen tier was not materially worse. *regret* = cheap
chosen but strong was materially better. *waste* = strong chosen but it bought nothing.

`P(random ≥ jev) = 1.000`. The shipped policy escalated every task, so it is identical to
always-strong and to random at the same rate, by construction.

**A perfect oracle saves 4%.** That is the ceiling for any router that must not lose quality
on this workload. Even allowing the oracle to also exploit cases where the cheap tier is
*more* expensive, it reaches 8%. The headroom this product is competing for is single digits.

## Why the shipped policy never downgrades

This is the finding worth acting on.

Of 87 decisions, Jev proposed Haiku 31 times. The policy took it **zero** times:

| reason | n |
|---|---|
| `jev/no-change` (Jev said stay) | 44 |
| `cache-rebuild-not-repaid` | 20 |
| `low-confidence-no-downgrade` | 10 |
| `jev` (upgrade to Opus) | 9 |
| `low-confidence-capped` | 3 |
| `override` | 1 |

The refusals are not a bug. **Measured first-request context was 37,188 tokens minimum,
37,467 median, 91,574 maximum — it was never small.** Claude Code's system prompt, tool
schemas and `CLAUDE.md` put a floor of ~37k tokens under every single turn.

At 37,467 tokens, using list prices:

- stay on Sonnet, cache warm: 37,467 × $0.20/MTok = **$0.0075** per turn
- switch to Haiku, cache cold: 37,467 × $1.25/MTok = **$0.0468** on the first turn,
  then $0.0037 per turn after

The switch costs ~$0.039 extra up front and saves ~$0.0037 per later turn, so it needs about
**11 more turns on the cheaper model just to break even** — before the 20% savings margin,
and before accounting for Haiku needing more turns anyway. Measured mean turns were 4.3
(Haiku) and 6.3 (Opus). Real sessions are nowhere near long enough.

**Haiku's cache-write price is 6× Sonnet's cache-read price.** In a cache-warm agentic
session, downgrading is a losing trade almost by arithmetic, independent of how good the
routing signal is.

## Downgrading is not reliably cheaper anyway

**On 14 of 86 tasks (16%) the cheap tier cost *more* than the strong one.** Haiku flails and
burns turns; a 12-turn Haiku session beats a 6-turn Opus session on price per token and loses
on price per task. Across the whole corpus all-cheap is 32% cheaper — real, but it buys 35%
quality, with 56 regrets.

## Threats to validity

1. **The judge is Opus, and it picked Opus 56 times against Haiku's 6.** Position-swapping
   controls for position bias, not self-preference. The cross-check — re-judging with a
   different family via `--judge fable` — **has not been run.** Until it is, the 65%
   escalation-worth rate should be read as an upper bound.
2. **The policy table scores a 3-tier policy against a 2-tier corpus.** The shipped policy
   chose Sonnet for 77 of 87 tasks, but only Haiku and Opus were ever replayed, so those
   Sonnet decisions are priced and scored *as Opus*. The `jev (shipped)` row is therefore an
   upper bound on cost and on quality. Sonnet — the default, and the policy's overwhelming
   choice — was never measured. This is the single biggest gap.
3. **Single-turn.** Each replay is one prompt in a fresh session. The cache economics above
   are precisely about multi-turn episodes, which this design cannot observe.
4. **83% of the corpus is model-generated**, and its difficulty labels are demonstrably
   uninformative. AUC is reported split by source for this reason.
5. **n=86**, so every CI is wide. The AUC drifted 0.375 → 0.397 → 0.484 → 0.536 → 0.564 →
   0.570 as pairs accumulated; the early "below chance" readings were noise, and the final
   figure should not be over-read either.
6. Tasks came from 4 repositories, 3 of them the author's.

## What would change the conclusion

- Measure Sonnet. A 3-tier corpus would let the shipped policy be scored as it actually runs.
- Re-judge with a non-Opus judge to bound self-preference.
- Multi-turn episodes, where a downgrade has enough turns to repay a cache rebuild.
- More harvested and fewer generated tasks.

## Reproducing

```
node bench/agentic/generate.mjs      # repo-grounded synthetic tasks
node bench/agentic/harvest.mjs       # real prompts from ~/.claude/projects
node bench/agentic/screen.mjs        # drop unusable tasks
node bench/agentic/replay.mjs        # tasks x tiers, tier-verified
node bench/agentic/judge.mjs         # blinded, position-swapped
node bench/agentic/decide.mjs        # the shipped router and policy
node bench/agentic/score.mjs         # this scoreboard
```

Every stage is resumable and stops cleanly on a Claude usage limit. This run took seven
5-hour windows.
