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
