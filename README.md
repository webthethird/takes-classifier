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

Active again as the harness for the **feed experiment**: can we rank real casts
by how much they invite a counter-argument, and does a feed of those make anyone
want to challenge one? See [the feed pipeline](#the-feed-pipeline) and
[what the first run showed](#what-the-first-run-showed).

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
(predictive / evaluative / prescriptive / descriptive), a coarse `aspect` tag, a
confidence, and — for the feed — a `challengeability` score with a user-facing
`challenge_reason`.

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

## The feed pipeline

`cluster.ts` answers "do these casts merge?". `feed.ts` answers the product
question: **"which of these would anyone want to argue with?"**

```sh
pnpm feed --top 30 data/*.json              # classify, cluster, rank
pnpm render-feed --out feed.html feed_*.json # ranked JSON -> standalone page
```

Three additions over `cluster.ts`:

**A challengeability score.** The classifier now emits `challengeability` and a
user-facing `challenge_reason` alongside `confidence`. These are different axes
and conflating them is the easy mistake — confidence asks "did I extract this
right?", challengeability asks "would anyone take the other side?" A cast can
score 0.95 confidence and 0.1 challengeability by being a perfectly-extracted
truism. The prompt tells the model to score low and mean it; a feed of 0.4s is a
dead feed.

**Ranking that trusts observation over the model.** Two empirical signals
override the model's own judgment, with weights as named constants at the top of
`feed.ts`:

- a cluster with people **already on both sides** is proven contested (1.5×)
- a deeper cluster is a live argument, not one person's passing thought (up to 2×)

Confidence is a gate, not a booster — a shaky extraction shouldn't ride a high
challengeability score to the top.

**A classify cache** (`src/lib/cache.ts`). Classification is the slow, paid step;
ranking is what you actually iterate on. Results are cached by cast text,
namespaced by `PROMPT_VERSION`, written atomically, and flushed on SIGINT/TERM/HUP.
Re-running to tune weights costs nothing, and a run killed partway resumes.
**Bump `PROMPT_VERSION` whenever the prompt or schema changes**, or reruns serve
stale results.

### What the first run showed

Over all four corpora (348 casts):

| | |
| --- | --- |
| Opinions kept | 73 (21%) |
| Distinct questions | 93 |
| Questions with 2+ casts | 7 |
| **Questions with both sides represented** | **1** |

That last number is the finding. The ranking leans on observed disagreement and
there's almost none to lean on.

It is *not* the matcher. Aspect filtering was the obvious suspect — `findMatch`
requires an exact `aspect` match while the mini app deliberately drops it — but
measuring it moved multi-member clusters from 5 to 7 and left both-sides at 1.
(Aspect filtering is therefore off by default in `feed.ts`, matching the mini
app; `--aspect` restores it to re-measure.)

It's the corpus. `data/` is four keyword searches returning isolated casts, and
isolated casts don't argue with each other — **disagreement lives in reply
threads**, which these pulls don't contain. `classifyCast` has accepted
`parentText` all along and the static corpora simply can't exercise it.

So the conclusion for live data is: pull threads, not search results. A spicy
cast plus its replies is a pre-packaged contested cluster. That's recorded in
`neynarSource`'s implementation notes in `src/lib/corpus.ts`.

### Two-stage classification

The thread pull alone did **not** produce contested markets — three live runs
with progressively better candidates all returned zero both-sides clusters.
The cause was visible in the thread data:

```
ROOT  [yes] "I could say the stupidest things and you'd clap"
            -> "Do Trump's supporters uncritically praise him regardless?"
REPLY [no]  "Maybe on the very surface they do, but otherwise not"
            -> "Are MAGA supporters generally intelligent?"      <-- new market
```

The reply is a direct rebuttal, but stage 1 asks "what question does this cast
raise?" — the wrong question for a reply. Passing `parentText` as context
doesn't help, because the *task* is wrong. So replies get a different task:

- **Stage 1** (`classifyCast`) — thread root → canonical question
- **Stage 2** (`classifyStance`) — each reply, *given that question* → yes / no / off_topic

Stage 2 is prompted to use `off_topic` freely; most replies in a real thread
take no position, and a manufactured stance pollutes a market with people who
never picked a side. Observed rate is about a quarter off-topic.

Result on the same live pull: **0 → 4 contested markets**, multi-member
clusters 1 → 20.

Note "contested" requires *different people* on opposite sides. Self-replies
are common on Farcaster and counting them inflated the first measurement from
4 to 7.

### Scope: no prediction markets

Takes has no oracle — the crowd settles everything — so a claim a fact will
settle is the wrong thing to host. The time-weighted crowd can pay out against
someone who turns out to be demonstrably right, which is a product that
punishes accuracy in public. Those belong on a real prediction market.

So stage 1 emits `externally_resolvable` and `feed.ts` drops those claims by
default (`--include-resolvable` keeps them). The axis is deliberately NOT
`claim_type`: "Will Verstappen win the title?" is resolvable and "Is Verstappen
the greatest ever?" never will be, and both are about the future.

The first version of this prompt over-fired badly, marking judgment calls
resolvable because facts happened to bear on them — "Was Doku brilliant in the
match?", "Was the striker's performance poor?", "Do elections meaningfully
change outcomes?". Sports context primes it especially hard. The fix was a
single test stated plainly in the prompt: **after the fact is known, is there
anything left to argue about?** Plus the real false positives as counter-
examples, and a note that adjectives like brilliant/fair/honest/significant
almost always mean `false`.

Known remaining miss: "Is market movement more honest when leverage is lower?"
is still marked resolvable despite appearing verbatim in the prompt as a
counter-example.

### Ranking: challengeable beats challenged

The boosts for contested and multi-member clusters were originally 1.5x and
2.0x, which inverted the product promise — a mediocre 0.5-challengeability
thread that happened to be contested outranked a 0.95 take nobody had replied
to yet. But the feed exists to surface opinions you COULD challenge, not
arguments already in progress. Boosts are now 1.2x and 1.4x: observed
disagreement corroborates, it doesn't dominate.

`both_sides` also requires *different people* on opposing sides. Self-replies
are common on Farcaster, and counting them inflated the first measurement from
4 to 7.

### Adding a live source

`src/lib/corpus.ts` defines `CastSource`; nothing downstream of it knows where
casts come from. `fileSource` reads the corpora; `neynarSource` is a stub with
the implementation notes. Wiring up live data means implementing that one
function — `feed.ts` doesn't change.

Note the engagement fields on `RawCast` (`replies`, `recasts`, `likes`) are
optional because the static corpora don't carry them. Live sources should
populate them: they're both the cheap pre-filter that keeps the Claude bill
proportional to signal rather than volume, and a ranking input.

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
