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
  // Field order is load-bearing. Structured output is emitted in schema
  // order, so putting the analysis BEFORE the verdict gives the model room to
  // reason; with stance first it commits to an answer and then rationalises.
  // Reordering these alone fixed inverted stances on nested replies.
  parent_says: z
    .string()
    .describe(
      "In one short sentence: what does the PARENT cast assert in relation to the question — does it support yes, support no, or take no position? Say 'parent is the root' if they are the same.",
    ),
  reason: z
    .string()
    .describe(
      "One or two sentences: does the reply agree or disagree with the parent, and what does that imply for the question? Agreement with a parent that opposes yes means the reply also opposes yes.",
    ),
  stance: z
    .enum(["yes", "no", "off_topic"])
    .describe(
      "Where the reply lands on the GIVEN question, following from the reasoning above. 'off_topic' when it takes no position on this specific question.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence in the stance call."),
});
export type StanceResult = z.infer<typeof StanceResult>;
