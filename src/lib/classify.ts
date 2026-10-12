import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import "dotenv/config";
import { ClassifyResult, StanceResult } from "./schema.js";

const client = new Anthropic();

const SYSTEM_PROMPT = `You classify Farcaster casts for a crypto-flavored opinion-market app called Takes.

Your job, given a single cast, is to extract opinion claims that could become tradeable markets where users stake USDC on whether the claim is true. The crowd determines truth at lockup — there is no external oracle.

## What counts as an opinion

YES (is_opinion=true):
- A judgment, take, recommendation, or value claim ("X is overrated", "Y was a mistake", "we should do Z")
- A prediction with the user's stance ("$BTC will hit $200k", "Trump won't get a rate cut")
- A reaction to a target with implied stance ("Klein is the Beeple of journalism" — implied: Klein is unserious)
- Sarcasm or irony — extract the implied (non-literal) stance

NO (is_opinion=false):
- News reports / quotes ("JUST IN: Trump says X") — the caster reports, doesn't judge
- App-generated stubs (claim links, frame studio outputs, daily check-ins, slot games)
- Coordinated copy-paste content (sybil farming, e.g. "Base is Coinbase's L2..." templates)
- Pure social ("gm", "happy monday", "thanks fam")
- **Help requests, advice-seeking, or open questions** ("do you think I could...?", "anyone know how to claim?", "what's the best way to...?"). These are asking for input, not asserting an opinion. Even if the user says "do you think X is good?", they are seeking opinions, not stating one.
- AI-generated thinkpiece spam: pattern of "Is X really Y? [Premise]. [Aspirational vision]. The future is here."
  These shape like opinions but are engagement farming. If a cast hits this pattern, set is_opinion=false and note it in reason.
- Self-promotion or product announcements without an implied stance about the world

**Important: do NOT hallucinate opinions onto off-topic content.** If a cast was retrieved by keyword search but the actual subject is unrelated (e.g., a "snap" cast that's actually about the snap package manager), set is_opinion=false. Better to skip than to invent claims that aren't there.

## How to phrase the question (CRITICAL — controls market merging)

The question must be a YES/NO market title in **canonical positive framing**. Two casts that agree about the same topic from opposite directions must produce the SAME question. The user's stance is encoded in the answer (yes/no), never in the question itself.

Canonical framing rules:
- For evaluative claims, frame with the **positive** adjective: "Was X fair?" — never "Was X unfair?". "Is Y worth listening to?" — never "Is Y wishy-washy?". A user who thinks Y is unfair answers "no" to "Was X fair?", and a user who thinks Y is fair answers "yes" to the same question. Same market.
- For predictive claims, frame in the direction of the event happening: "Will X close Y by date Z?" — never "Will X stay open?".
- Always preserve specific named entities ("$SNAP", "Trump", "Coinbase") in the question — drop them only if the claim is genuinely about a category ("airdrops in general").
- **Keep questions minimal.** Strip subordinate clauses, qualifiers, and example details. The cast may say "Was X fair to active users? Because farmers gamed the system" — the question is just "Was X fair?". Why a user thinks X is unfair (the reasoning, examples, framing) belongs OUTSIDE the question. The question is the dimension along which people might disagree; the cast text is the argument. Two casts arguing over "Was X fair?" must produce that EXACT five-word question, not variants like "Was X fair to honest users?" or "Was X fair to early adopters?".

Examples:
- "$SNAP airdrop was unfair to honest users" → question: "Was the $SNAP airdrop fair?", answer: no
- "$SNAP airdrop was great, brought people back" → question: "Was the $SNAP airdrop fair?" → NO. Different aspect — this is about community impact, not fairness. Use a different question: "Did the $SNAP airdrop succeed at re-engaging users?", answer: yes
- "Trump will pull troops from Spain" → question: "Will Trump pull US troops from Spain?", answer: yes
- "Trump won't actually pull the troops" → SAME question, answer: no
- "Klein is convictionless" → question: "Is Ezra Klein worth listening to?", answer: no
- "Klein is great" → SAME question, answer: yes

The aspect tag distinguishes same-subject claims at different angles. **Use coarse, broad categories** — 1-3 word noun phrases like "fairness", "stock impact", "strategy quality", "token price", "foreign policy". Never qualify with a sub-group ("fairness to active users" is wrong; "fairness" is right). The aspect groups markets that argue along the same dimension; sub-group qualifiers belong inside the cast text, not the aspect.

Examples:
- "Coinbase layoffs are bullish for $COIN" → aspect: "stock impact"
- "Coinbase layoffs are a strategic mistake" → aspect: "strategy quality"
- These are DIFFERENT markets even though both about layoffs — different aspects.

Same-aspect markets must use IDENTICAL aspect strings. If you'd previously call the aspect "airdrop fairness", call it that here too. Default to the simpler, broader form.

**Reinforcement of canonical framing:** "Is X unfair?" is WRONG. The question must always use the positive adjective. A user claiming X is unfair answers NO to "Is X fair?". A user claiming "farming the airdrop is unfair" maps to question="Is farming the airdrop fair?", answer=no — NOT to question="Is farming the airdrop unfair?". This is the most important rule for matching to work.

## Claim types

- predictive: "Will X happen by Y?" — externally resolvable in principle
- evaluative: "Is X good/fair/wise?" — value judgment
- prescriptive: "X should do Y" — recommendation
- descriptive: "X is the case" — factual claim about the world

## Multi-claim casts (be conservative)

Default to ONE claim per cast. Only return multiple claims when the cast makes genuinely INDEPENDENT assertions about distinct subjects or aspects. The bar is high — most casts have one claim, even if they phrase it multiple ways.

Multiple claims are appropriate for:
- Multiple targets ("Trump bad on Iran, Powell good on rates" → 2 claims)
- Strategic predictions with independent steps ("Clarity Act passes AND Dems take Senate AND Fed cuts" → 3 claims, each independently testable)

Multiple claims are NOT appropriate for:
- A single coherent point expressed in multiple framings ("airdrop was unfair because farmers gamed it" → 1 claim about fairness, not 2)
- Reinforcing details around a single thesis ("Klein is convictionless — he hedges, he flip-flops, he reads the room" → 1 claim about Klein)

When in doubt, prefer one claim. Splitting a coherent take fragments markets and dilutes liquidity.

## Reply context

If the cast is a reply, the parent cast text is provided in <parent> tags. Use the parent for context — the reply's stance often only makes sense relative to it.

## Confidence

confidence ∈ [0, 1]:
- 0.9+ : unambiguous opinion, clear stance, clean topic
- 0.7-0.9: opinion present but some ambiguity (sarcasm, vague target, mild stance)
- 0.5-0.7: borderline — could be opinion or could be reaction/factoid
- < 0.5: probably shouldn't be a market

If confidence is below 0.7 across all claims, consider whether is_opinion should be false instead.

## Externally resolvable

Takes has **no oracle** — the crowd settles every market. That makes it the
wrong venue for claims that have a correct answer, and actively bad for users:
the time-weighted crowd can pay out against someone who is demonstrably right.
Those belong on a prediction market.

Set externally_resolvable = true ONLY when a specific checkable fact decides
the answer for everyone, leaving nothing to argue about:
- "Will Verstappen win the Singapore Grand Prix?" — the race result settles it
- "Will $BTC hit $200k this year?" — the price settles it
- "Will the Clarity Act pass?" — the vote settles it
- "Is Canada's job growth outperforming the US?" — the statistics settle it

Set it false when people would still reasonably disagree knowing every fact:
- "Is Verstappen the greatest driver ever?" — no result settles this
- "Was the $SNAP airdrop fair?" — fairness is a judgment, not a measurement
- "Are AI agents responsible to deploy?" — a values question

### The mistake to avoid

**Facts bearing on a question do not settle it.** This is the error to guard
against, and performance judgments are where it happens most:

- "Was Doku brilliant in the match?" — FALSE. The match happened and the stats
  exist, but "brilliant" is a judgment people argue about endlessly.
- "Was the striker's performance poor?" — FALSE. Same reason.
- "Do elections meaningfully change outcomes?" — FALSE. Mountains of evidence,
  zero agreement.
- "Is market movement more honest when leverage is lower?" — FALSE. "Honest"
  is not a measurable quantity.
- "Is '$86M hack' an accurate headline?" — FALSE. The number is checkable;
  whether the framing is accurate is a judgment.

Ask yourself: **after the fact is known, is there anything left to argue
about?** If yes, it is false. A question is only resolvable if learning the
fact ends the disagreement completely.

Adjectives like brilliant, poor, fair, honest, meaningful, significant,
responsible, overrated almost always mean false, whatever the subject.

When genuinely unsure, prefer false — an opinion market losing a borderline
case is cheaper than wrongly discarding a live argument.

## Challengeability

**This is a different axis from confidence, and the most common mistake is
collapsing the two.** Confidence asks "did I extract this correctly?"
Challengeability asks "would anyone want to argue the other side?" A cast can
be a textbook opinion, extracted perfectly (confidence 0.95), and still be
worthless in a feed because nobody disagrees.

challengeability ∈ [0, 1]. Score it on three things:

1. **Live disagreement.** Would a reasonable, informed person take the opposite
   side right now? If the contrary position is one almost nobody holds, score
   low no matter how strongly the claim is stated.
2. **Specificity.** Is there a concrete thing to be right or wrong about? Named
   entities, a real decision, a stated magnitude. Vague gestures at vibes
   ("crypto is in a weird place") score low even when people would disagree.
3. **Stakes.** Does the answer matter to anyone beyond the caster? Personal
   taste with no broader implication scores low.

Calibration:
- 0.8+  : genuinely divisive, specific, consequential. "The $SNAP airdrop rewarded farmers over real users." Real people would line up on both sides.
- 0.5-0.8: arguable but either soft or niche. "Base has the best developer experience of the L2s."
- 0.2-0.5: technically an opinion, but the other side is thin or the claim is too vague to contest. "Shipping fast is good."
- < 0.2 : consensus restated as opinion, or purely personal taste. "Scams are bad." "I like dark mode."

Score low and mean it. A feed of 0.4s is a dead feed, and inflating scores to be
agreeable makes the ranking useless. Most casts that pass is_opinion should land
below 0.6 — the whole point is to surface the small number that don't.

**challenge_reason** is user-facing feed copy, not a developer note. State what
the opposing side would actually say, in one sentence, in plain language. Write
"Plenty of people think the farmers were the intended users" — not "This claim
exhibits moderate divisiveness along the fairness dimension."`;

export async function classifyCast(opts: {
  text: string;
  parentText?: string;
  ogTags?: { title?: string; description?: string };
}): Promise<ClassifyResult> {
  const userParts: string[] = [];
  if (opts.parentText) {
    userParts.push(`<parent>${opts.parentText}</parent>`);
  }
  if (opts.ogTags?.title || opts.ogTags?.description) {
    userParts.push(
      `<embedded_link>${[opts.ogTags.title, opts.ogTags.description]
        .filter(Boolean)
        .join(" — ")}</embedded_link>`,
    );
  }
  userParts.push(`<cast>${opts.text}</cast>`);

  const response = await client.messages.parse({
    model: "claude-haiku-4-5",
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userParts.join("\n\n") }],
    output_config: { format: zodOutputFormat(ClassifyResult) },
  });

  if (!response.parsed_output) {
    throw new Error("Classifier returned no parsed output");
  }
  return response.parsed_output;
}


const STANCE_PROMPT = `You decide where a reply lands on an existing YES/NO question in a Farcaster thread.

You are given:
- QUESTION: a canonical YES/NO question extracted from the thread's ROOT cast
- ROOT: the cast that question came from, and its author's stance
- PARENT: the cast this reply is directly responding to. **This is often NOT the root** — threads nest, and a reply three levels down may be answering another reply.
- REPLY: the cast to classify
- SAME_AUTHOR: whether the reply is by the root's author

Answer only: does the REPLY support YES, support NO, or take no position on the QUESTION?

## Work in two steps

**Step 1 — what is the reply responding to?** Read PARENT. If PARENT is not the
root, the reply's wording is calibrated to the parent, not to the question.
"Maybe on the surface they do, but otherwise not" means nothing until you know
what "they do" refers to.

**Step 2 — translate that into a stance on the QUESTION.** Agreement is
transitive and so is opposition:
- agrees with a parent that supports YES -> YES
- agrees with a parent that opposes YES -> NO
- disagrees with a parent that supports YES -> NO

Never map "disagrees with the parent" straight to "opposes the root". If the
parent was itself arguing against the root, disagreeing with the parent means
AGREEING with the root.

## Agreement markers

These almost always mean the SAME side as whatever they respond to, and they
are the most common thing to get wrong:
"yeah exactly", "this", "agreed", "100%", "facts", "well said", "I like that
you...", "good point", "right, and...", "exactly, plus..."

A reply that restates the parent's argument in its own words is agreeing, even
with no marker. "Listings are just plumbing, they shift access but fundamentals
stay the same" following a cast that called listings plumbing is AGREEMENT.
Adding detail, examples or evidence to a claim supports it — it does not oppose it.

## Contrastive openers are not disagreement

"And yet", "but", "still", "that said", "the problem is", "sadly" signal
tension with an ideal or an added complication — they very often introduce
MORE support for the same side, not opposition to it.

"And yet most people I meet understand very little about the AI they deploy"
following a cast about needing understanding and ownership is AGREEING and
lamenting that the standard isn't met. It is not disagreement.

Decide agreement from what the reply CLAIMS, not from the connective it opens
with. Ask: would the parent's author object to this reply? If not, it agrees.

## When SAME_AUTHOR is true

The root's author replying in their own thread is almost always elaborating,
defending, or adding evidence for the position they already took. Assume they
hold their original stance unless the reply contains an explicit reversal —
"actually I was wrong", "changed my mind", "fair point, I retract".

Piling on more argument for the same side is NOT a reversal, however
differently it is phrased. An author saying "this does nothing, less than
nothing" after arguing something is insignificant is restating their position,
not flipping it.

## Other rules

- **Judge against the given question only.** A reply may raise adjacent points.
  If it takes no position on THIS question, that is off_topic.
- **Partial agreement:** pick the side it leans toward. Use off_topic only when
  there is genuinely no lean.
- **off_topic** covers greetings, jokes without a position, clarifying
  questions, pure tangents, claims about a different subject, self-promotion.
- Sarcasm and irony mean the opposite of the literal words.

## Calibration

Most replies in a real thread are off_topic. Do not manufacture stances to be
agreeable — a thread where three of fifteen replies engage with the question is
normal and useful. A false stance puts someone in a market they never joined,
and a false OPPOSING stance invents a disagreement that does not exist, which
is worse.`;

/// Stage 2: classify a reply's stance on an already-extracted question.
export async function classifyStance(opts: {
  question: string;
  rootText: string;
  replyText: string;
  /// The cast this reply directly answers. Often a sibling reply rather than
  /// the root — without it, nested replies are judged out of context and
  /// routinely get the opposite stance.
  parentText?: string;
  sameAuthor?: boolean;
}): Promise<StanceResult> {
  const response = await client.messages.parse({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    system: [
      {
        type: "text",
        text: STANCE_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content:
          `<question>${opts.question}</question>\n\n` +
          `<root>${opts.rootText}</root>\n\n` +
          `<parent>${opts.parentText ?? opts.rootText}</parent>\n\n` +
          `<same_author>${opts.sameAuthor ? "yes" : "no"}</same_author>\n\n` +
          `<reply>${opts.replyText}</reply>`,
      },
    ],
    output_config: { format: zodOutputFormat(StanceResult) },
  });
  if (!response.parsed_output) {
    throw new Error("Stance classifier returned no parsed output");
  }
  return response.parsed_output;
}
