import { z } from "zod";

// Stage 1 output: structured extraction from a single cast.
// One cast can contain multiple claims (multi-topic case).

export const ClaimType = z.enum([
  "predictive", // "will X happen by Y?" — externally resolvable
  "evaluative", // "is X good/fair/wise?" — judgment
  "prescriptive", // "X should do Y" — recommendation
  "descriptive", // "X is the case" — factual claim
]);
export type ClaimType = z.infer<typeof ClaimType>;

export const Claim = z.object({
  question: z
    .string()
    .describe(
      "A YES/NO question that captures the claim. Must be phrased so a YES/NO answer is meaningful. This becomes the market title.",
    ),
  answer: z.enum(["yes", "no"]).describe("The user's stance on the question."),
  claim_type: ClaimType,
  aspect: z
    .string()
    .describe(
      "Short noun phrase identifying what is being judged (e.g., 'airdrop fairness', 'token price', 'foreign policy'). Used to disambiguate same-subject markets.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident the classifier is that this claim is correct."),
  challengeability: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "How much this claim invites someone to take the opposing side. High when reasonable people genuinely disagree and the claim is specific enough to argue about. Low for truisms, settled facts, and vague gestures. This is NOT the same as confidence — a claim can be extracted with high confidence and still be boring to argue with.",
    ),
  externally_resolvable: z
    .boolean()
    .describe(
      "True if a future fact or event will settle this claim for a neutral observer — a race result, a price, a vote count, a shipped product. False if people would still reasonably disagree even knowing every fact. This is NOT the same as claim_type: 'Will Verstappen win the title?' is resolvable, 'Is Verstappen the greatest driver ever?' never will be, and both concern the future.",
    ),
  challenge_reason: z
    .string()
    .describe(
      "One short sentence naming the disagreement: what the opposing side would actually say. Used as feed copy, so write it to be read by a user, not a developer.",
    ),
});
export type Claim = z.infer<typeof Claim>;

export const ClassifyResult = z.object({
  is_opinion: z
    .boolean()
    .describe(
      "True if the cast contains at least one opinion. False for news reports, app stubs, claim-link spam, social greetings, questions without implied stance, etc.",
    ),
  reason: z
    .string()
    .describe(
      "One short sentence explaining why is_opinion was set the way it was. If is_opinion is false, identify the cast type (news/spam/social/etc).",
    ),
  claims: z
    .array(Claim)
    .describe(
      "List of opinion claims extracted from the cast. Empty if is_opinion is false. Multiple entries when the cast makes multiple distinct claims.",
    ),
});
export type ClassifyResult = z.infer<typeof ClassifyResult>;

// Market index entry (in-memory for prototype; vector DB for production)
export type IndexedMarket = {
  id: string; // synthetic for prototype
  question: string;
  claim_type: ClaimType;
  aspect: string;
  embedding: number[];
  // Provenance for debugging
  seeded_by_cast: string; // cast hash or username:ts
};

export type MatchResult = {
  market: IndexedMarket;
  similarity: number;
};

// ── Stage 2: stance of a reply on an existing question ──────────────────
//
// Separate from ClassifyResult on purpose. Stage 1 asks "what question does
// this cast raise?", which is the wrong question for a reply — a reply to
// "Do Trump's supporters clap for anything?" saying "maybe on the surface,
// but otherwise no" is a NO on that question, not a new market about MAGA
// intelligence. Asking the model to generate a question for it guarantees a
// disjoint cluster, which is exactly what the first live runs produced.

export const StanceResult = z.object({
  // Field order is load-bearing: structured output is emitted in schema order,
  // so the analysis must come BEFORE the verdict or the model commits first
  // and rationalises after.
  //
  // The intermediates are TYPED, not free text. A prose summary of the parent
  // loses the question's polarity — "the parent says you must have governance"
  // reads positive even when the parent's stance on a negatively-framed
  // question is no. Every observed inversion came through that gap.
  yes_would_mean: z
    .string()
    .describe(
      "Plain restatement of what answering YES to this question commits you to. Watch for negation in the question: for 'Is it responsible to act without understanding?', YES means 'it IS responsible even without understanding'.",
    ),
  parent_stance: z
    .enum(["yes", "no", "none"])
    .describe(
      "The PARENT cast's position on the question — not a summary of what it says. 'none' if the parent takes no position. If the parent is the root, this is the root author's stance.",
    ),
  agreement: z
    .enum(["agree", "disagree", "neither"])
    .describe(
      "Does the reply agree or disagree with the PARENT (not with the question)? Praise, restatement, and adding supporting detail are 'agree'.",
    ),
  explicit_reversal: z
    .boolean()
    .describe(
      "Only meaningful when the reply is by the root's author. True ONLY if they explicitly retract or reverse their earlier position ('actually I was wrong', 'changed my mind', 'fair point, I retract'). Adding caveats, lamenting, or arguing the same side harder is NOT a reversal.",
    ),
  reason: z
    .string()
    .describe(
      "One or two sentences tying the above together into the stance below.",
    ),
  stance: z
    .enum(["yes", "no", "off_topic"])
    .describe(
      "Where the reply lands on the question. When parent_stance is yes/no and agreement is agree/disagree, this follows mechanically: agreeing with a 'no' parent is 'no'; disagreeing with a 'no' parent is 'yes'.",
    ),
  confidence: z.number().min(0).max(1).describe("Confidence in the stance call."),
});
export type StanceResult = z.infer<typeof StanceResult>;
