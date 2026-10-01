# takes-classifier

Offline prototype for the hardest part of **Takes**: turning messy Farcaster casts into clean, *mergeable* opinion markets.

Part of a three-repo project:

- **takes-classifier** (this repo) — CLI harness for developing and evaluating the classification + clustering logic against real cast corpora
- [takes-miniapp](https://github.com/webthethird/takes-miniapp) — the Farcaster mini app, where the shipping version of this logic lives in `lib/`
- [takes-contracts](https://github.com/webthethird/takes-contracts) — Foundry project: factory + per-question markets on Base

## Status

Prototype, and intentionally so — this repo exists to iterate on prompts and
thresholds with fast feedback, not to run in production. The validated logic was
ported into the mini app (`lib/classify.ts`, `lib/embed.ts`, `lib/market-index.ts`)
with the local embedding model swapped for a hosted one.

**Development is paused** along with the rest of the project.

## The problem

Takes stakes USDC on YES/NO questions with no oracle — the crowd settles it. That
only works if people who disagree land in the **same market**. Two failure modes
kill it:

1. **Fragmentation.** "The $SNAP airdrop was unfair to real users" and "the $SNAP airdrop was great" are the same argument from opposite sides. If they produce two markets, each has one staker and neither means anything.
2. **Noise.** Most of a Farcaster timeline isn't opinion at all — news reposts, airdrop-claim spam, copy-paste sybil templates, "gm", AI thinkpiece slop, people asking questions rather than asserting. Minting markets from those is worse than minting nothing.

So the classifier has two jobs: reject non-opinions, and phrase everything it
keeps in a form that *collides on purpose*.

## Approach

**Stage 1 — classify (`src/lib/classify.ts`).** One Claude call per cast with a
zod-enforced output schema (`is_opinion`, `reason`, `claims[]`). Each claim is a
YES/NO `question`, the caster's `answer`, a `claim_type`
(predictive / evaluative / prescriptive / descriptive), a coarse `aspect` tag, and
a confidence.

The system prompt is most of the engineering here, and it's built around one rule:
**canonical positive framing.** The question always uses the positive adjective,
and the stance lives in the answer, never in the question.

```
"airdrop was unfair to honest users"  →  "Was the $SNAP airdrop fair?"  answer: no
"airdrop was great, brought people back" → "Was the $SNAP airdrop fair?"  answer: yes
```

Questions are also kept minimal — subordinate clauses and qualifiers get stripped,
because "Was X fair?" and "Was X fair to early adopters?" would otherwise become
different markets. The argument belongs in the cast text; the question is only the
axis of disagreement.

The `aspect` tag separates same-subject claims along genuinely different axes:
"Coinbase layoffs are bullish for $COIN" (stock impact) and "Coinbase layoffs are a
strategic mistake" (strategy quality) *should* be different markets.

**Stage 2 — match (`src/lib/embed.ts`, `src/lib/match.ts`).** Embed the question
(`Xenova/all-MiniLM-L6-v2`, 384-dim, running locally via ONNX) and cosine-compare
against the market index, filtered to the same claim type and aspect:

| Similarity | Outcome |
| --- | --- |
| ≥ 0.85 | `match` — join the existing market |
| ≥ 0.70 | `ambiguous` — return top 3, let the caller disambiguate |
| < 0.70 | `new` — seed a market from this claim |

Embeddings are L2-normalized, so cosine is just a dot product.

## Usage

```sh
pnpm install
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env
```

**Single cast** — fast prompt iteration:

```sh
pnpm classify "$SNAP airdrop was a joke"
echo "ETH will hit $5k this cycle" | pnpm classify
pnpm classify --parent "Excited about $SNAP!" "Yeah I sold instantly"
```

Prints the raw `ClassifyResult` as JSON. Passing `--parent` gives the classifier
the thread context a reply depends on.

**Batch clustering** — the actual evaluation loop:

```sh
pnpm cluster data/snap.json
pnpm cluster --limit 50 data/coinbase.json
```

Classifies every cast, greedily matches each claim into an in-memory index, and
writes `clusters_<corpus>_<timestamp>.json` with every market, its members (stance,
similarity, author, text), and every rejected cast *with the reason*. A summary and
the top 10 markets by member count go to the terminal.

The rejected list is the most useful output. Reading why a cast was dropped is how
you find the prompt's blind spots — it's where the spam-pattern and
question-vs-assertion rules in the current prompt came from.

```sh
pnpm typecheck
```

## Corpora

`data/` holds ~350 real casts pulled across four topics, deliberately unfiltered:

| File | Casts | Why it's here |
| --- | --- | --- |
| `coinbase.json` | 148 | heavy airdrop/points spam — tests rejection precision |
| `politics.json` | 96 | strong opinions, little crypto vocabulary |
| `trump.json` | 64 | news reposts vs. actual takes, a hard distinction |
| `snap.json` | 43 | one event, many angles — the merging case |

Shape is `{ ts, username, text, channel, parent_hash }[]`, plus `fid` on some.

## Divergence from the shipping version

The mini app's port differs in two deliberate ways:

- **Embeddings are hosted there** (OpenAI `text-embedding-3-small`, 1536-dim). `@xenova/transformers` needs ONNX runtime and a writable filesystem cache, which Vercel functions don't provide. Local inference is better here: free, offline, and fast enough for repeated batch runs.
- **Aspect is not used as a match filter there.** The classifier drifts between "airdrop fairness" and "fairness", and a mismatched aspect silently blocks an otherwise-good match. The question embedding carries the signal on its own. This repo still filters on aspect, which is the stricter behavior and useful for seeing how much the tag actually moves.

Embedding dimensions differ between the two, so indexes are not interchangeable.
