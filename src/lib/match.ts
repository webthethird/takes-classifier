import { Claim, IndexedMarket, MatchResult } from "./schema.js";
import { cosine } from "./embed.js";

export const MATCH_THRESHOLD = 0.85;
export const AMBIGUOUS_THRESHOLD = 0.7;

export type MatchOutcome =
  | { kind: "match"; market: IndexedMarket; similarity: number }
  | {
      kind: "ambiguous";
      candidates: MatchResult[]; // sorted desc by similarity
    }
  | { kind: "new" };

export function findMatch(
  claim: Claim,
  claimEmbedding: number[],
  index: IndexedMarket[],
): MatchOutcome {
  // Filter to candidates with same claim_type AND same aspect
  const candidates = index
    .filter(
      (m) => m.claim_type === claim.claim_type && m.aspect === claim.aspect,
    )
    .map((m) => ({ market: m, similarity: cosine(claimEmbedding, m.embedding) }))
    .sort((a, b) => b.similarity - a.similarity);

  if (candidates.length === 0) return { kind: "new" };
  const top = candidates[0];
  if (top.similarity >= MATCH_THRESHOLD) {
    return { kind: "match", market: top.market, similarity: top.similarity };
  }
  if (top.similarity >= AMBIGUOUS_THRESHOLD) {
    return { kind: "ambiguous", candidates: candidates.slice(0, 3) };
  }
  return { kind: "new" };
}
