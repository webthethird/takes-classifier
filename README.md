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

### Two candidate lanes

Filtering candidates on reply count excludes every provocative cast nobody has
answered yet — which is precisely what the feed exists to surface. So there are
two lanes, merged and deduped by cast hash before ranking:

1. **Existing debate** — substantive casts with `>= --min-replies` replies,
   expanded into threads and run through stage 1 + stage 2.
2. **Unchallenged hot takes** (`--unchallenged N`) — substantive casts
   regardless of reply count, newest first, never expanded. One stage-1 call
   each, no conversation fetch, so the lane is cheap.

Measured on a live pull, the unchallenged lane contributed 5 of 21 feed cards,
all with zero replies.

### Ranking: challengeable beats challenged

The boosts for contested and multi-member clusters were originally 1.5x and
2.0x, which inverted the product promise — a mediocre 0.5-challengeability
thread that happened to be contested outranked a 0.95 take nobody had replied
to yet. Reducing them to 1.2x and 1.4x helped but did not fix it, because the
problem was structural rather than a weighting accident: **a cast with zero
replies cannot accumulate members**, so any size multiplier locks the entire
unchallenged lane out of the top of the feed.

Measured with both lanes running, the two populations had near-identical median
challengeability (0.60 unchallenged vs 0.62 threads) but clearly different
median scores (0.52 vs 0.61), and 9 of 29 ranking inversions were a thread
beating a *more* challengeable take that happened to have no replies.

So corroboration no longer multiplies — it reorders within a tier.
Challengeability is gated by confidence, quantized into 0.1 bands, and
`both_sides` plus distinct-author credit only sorts cards *inside* a band:

| inversions measured against | before | after |
| --- | --- | --- |
| band (the actual tier) | — | **0**, by construction |
| confidence-gated challengeability | — | 17 |
| raw challengeability | 29 | 26 |

A 0.70 take never loses to a 0.60 take. The remaining reorderings are all
within-band, with gated differences of 0.003–0.041 — noise settled by real
disagreement, which is the intent. (Inversions against *raw* challengeability
include the confidence gate deliberately demoting shaky extractions.)

Author credit counts distinct people, not casts.

`both_sides` also requires *different people* on opposing sides. Self-replies
are common on Farcaster, and counting them inflated the first measurement from
4 to 7.

### Stage 2 reads the actual parent, and reasons before it answers

Two bugs made the classifier invent disagreements that weren't there. Both
showed up as authors apparently contradicting themselves in their own threads.

**Replies were judged against the root, not their real parent.** Threads nest,
and a reply three levels down is answering a sibling reply. "Maybe on the very
surface they do, but otherwise not" is meaningless until you know what "they
do" refers to — read against the root it looks like negation, read against its
actual parent it's agreement. `parent_text` was in the data all along;
`classifyStance` just never received it. It now gets the question, the root,
the immediate parent, and whether the reply is by the root's author.

Agreement and opposition are transitive, and the prompt now says so
explicitly: agreeing with a parent that opposes the root means agreeing with
the root. Agreement markers ("yeah exactly", "this", "I like that you...") and
restating the parent's argument in new words are called out, because those
were being read as opposition.

**Field order in the output schema was hiding the reasoning.** Structured
output is emitted in schema order, so with `stance` declared first the model
committed to a verdict and then rationalised it. `StanceResult` now asks for
`parent_says` and `reason` *before* `stance`. That reorder alone flipped three
stubborn misclassifications to correct — it was worth more than any prompt
wording change.

Self-replies get an explicit prior: an author elaborating in their own thread
is defending their position, not reversing it. Piling on more argument for the
same side is not a reversal however differently it's phrased.

Measured on one live pull, the four known-bad decisions went to correct, and
self-contradicting replies fell from 3 to 2 of 33 stage-2 calls.

### Polarity: typed intermediates and a self-reply prior

A second round of inverted stances, all in one cluster, came from a
negatively-framed question: "Is it responsible to deploy AI agents *without*
full understanding?" Agreeing that understanding matters means **no**.

The audit showed the model reasoning correctly and then answering the
opposite. The tell was in its own summary of the parent. When the parent was
the root it recorded a *stance* ("it is not responsible to...") and got the
answer right. When the parent was another reply it recorded a *positive
assertion* ("you must have governance and ownership") — and "agrees with a
positive statement" became yes, losing the question's polarity.

Free text can't carry polarity. `StanceResult` now asks for typed
intermediates before the verdict:

- `yes_would_mean` — plain restatement of what YES commits you to, which
  defuses the negation in the question
- `parent_stance` — the parent's position on the question as `yes | no | none`,
  not a prose summary
- `agreement` — `agree | disagree | neither`, about the parent, not the question
- `explicit_reversal` — for self-replies only

With those typed, transitivity is mechanical, and `reconcileStance` derives the
stance rather than trusting the verdict: agreeing with a `no` parent is `no`.
It defers to the model where derivation can't decide — `none` parent stance,
`neither` agreement, or `off_topic`.

Two further traps the prompt now names explicitly:

- **Contrastive openers are not disagreement.** "And yet most people understand
  very little about the AI they deploy" agrees with a parent arguing for
  understanding; it laments that the standard isn't met. "And yet", "but",
  "still", "that said" were all being read as opposition. Decide from what the
  reply claims, not the connective it opens with.
- **Self-replies keep their author's stance** unless they explicitly retract.
  Every self-reply assigned an opposing stance in the samples we checked was
  wrong, so without an explicit reversal the author keeps their own side.

Result on the same cluster: self-contradicting replies went 2 -> 0 across 35
stage-2 decisions, a praise reply ("I like that you tied ownership to a named
responsible person") stopped being shown as disagreement, and the genuine
rebuttal — "the disagreement worth having: approval doesn't scale to 10k agent
tasks a day" — took the highlight slot instead.

`pickOpposingReply` also weights confidence by how substantive the rebuttal is,
so a developed counter-argument outranks a terse reaction.

### Deduplication

Near-duplicate cards reached the feed in three distinct ways, each needing a
different fix.

**One cast fronting two cards.** Stage 1 can return several claims for a single
cast; each becomes its own cluster, and the same cast gets picked to front both.
In cast-first layout that is literally the same words twice under two questions.
Representatives are now assigned *after* ranking, walking in score order:
`assignRepresentatives` gives the top card its best cast, and a lower card
either falls back to a different member or is dropped (reported as
`duplicate_cards_dropped`). This is a structural guarantee — it holds regardless
of how the classifier behaves.

**The classifier over-splitting one point.** The pairs it produced were a claim
and its own mechanism, or the same claim stated from each side:

```
"Contrarianism is easier than most people think"
  -> Is contrarianism easier to practice than most people believe?
  -> Does a cognitive bias exist that makes contrarian views seem credible?
```

The prompt's test is now explicit: *would the two questions attract the same
people arguing the same thing?* It names the observed failures and forbids
emitting a claim for the mechanism, implication, or inverse of another claim
from the same cast.

**The match threshold being marginally too strict.** "Is the new press secretary
competent?" and "...performing well?" sat at 0.843, just under the old 0.85.
Measured across 208 pooled questions, the `[0.80, 0.85)` band is overwhelmingly
genuine duplicates — "diesel deal strategically significant" / "fuel deal
geopolitically significant", "attract the most builders" / "earn the most
builders". `MATCH_THRESHOLD` is now **0.82**, overridable by env var to
re-measure. The clearest false merge in that band (Raikkonen championship vs
Singapore GP) is a predictive claim the resolvable filter drops first.

After all three: 0 duplicate lead casts, and the most similar remaining
question pair in a live feed sits at 0.522 — a wide margin below threshold.

### Auditing stance decisions

Counts hide inverted stances; reading them doesn't. `pnpm audit-stances`
prints every stage-2 decision with the inputs that produced it:

```sh
pnpm audit-stances -- feed_<ts>.json           # all decisions
pnpm audit-stances -- --self feed_<ts>.json    # self-replies only
```

Each row shows what the reply was responding to, what the model thought the
parent asserted, the stance, and why — and flags any case where an author
contradicts their own root, which is the shape of the original bug. Note the
`--` : `pnpm audit` is a built-in pnpm command, so the flags need separating.

### Two layouts, one dataset

`render-feed.ts` takes `--layout question|cast` and renders the same report
both ways, so the comparison isn't confounded by different candidates or
ranking:

```sh
pnpm feed --trending-channels 1d --search "unpopular opinion" --top 25
pnpm render-feed --layout question --out a.html feed_<ts>.json
pnpm render-feed --layout cast     --out b.html feed_<ts>.json
```

**A (question-first)** leads with the canonical question and hides source
casts behind a disclosure. **B (cast-first)** leads with a real person's
verbatim words; the derived question sits underneath in a subordinate block.

B exists because of a product argument worth stating: the canonical question
supplies normalization, but the *cast* supplies the person, the context, and
the reason anyone would care. Nobody wants to argue with a debate prompt. They
want to argue with someone who said something. So the AI output should make a
human statement actionable, not replace it in the headline position.

Mechanics of the cast-first card:

- **Back / Challenge are relative to the cast, never the question.** If the
  lead cast argues `no` on a positively-framed question, "Back this take"
  means `no` and "Challenge" means `yes`. Resolved in `feed.ts`
  (`back_means` / `challenge_means`) so the renderer can't disagree with the
  pipeline. A user should never need to understand canonical framing to
  disagree with someone.
- **The lead cast is chosen deterministically** — `pickRepresentative` prefers
  the cast the question was extracted from over a reply, then
  challengeability, then engagement, then cast id. Always a real cast, never
  an AI paraphrase.
- **Real disagreement outranks hypothesised disagreement.** When an opposing
  cast from a different person exists it is shown inline and labelled
  "Someone already disagrees". Only when none exists does the card fall back
  to `challenge_reason`, which is explicitly marked **AI hypothesis**. These
  must not look alike: one is evidence, the other is a guess.
- Every cast keeps author, channel, date and a Farcaster permalink.

### Counting people, not messages

`yes_casts` and `yes_authors` are different numbers and the UI says which it
means. One author posting four times does not make a side four people strong,
and none of these counts are stake, votes, or a poll — they are classified
source-cast stances.

The contested test had a real bug here. It looked for an author who posted
*only* yes and another who posted *only* no, so this returned false:

```
Alice: yes
Bob:   yes
Bob:   no     <- Alice and Bob genuinely disagree, but Bob is in both sets
```

The right question is whether any yes-member and any no-member are different
people. Fixing it moved contested clusters from 4 to 6 on an identical pull.
Identity prefers FID over username, since usernames are mutable. `pnpm test`
covers self-replies, mixed-stance authors, independent opposition, and
deterministic representative selection.

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
