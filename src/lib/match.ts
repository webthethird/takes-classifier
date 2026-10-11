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
  /// Require an exact `aspect` match as well as claim_type. The miniapp
  /// disables this: the classifier drifts between near-identical tags
  /// ("airdrop fairness" vs "fairness") and a mismatch silently blocks an
  /// otherwise-good merge. Kept togglable so the cost is measurable.
  opts: { matchAspect?: boolean } = {},
): MatchOutcome {
  const { matchAspect = true } = opts;
  const candidates = index
    .filter(
      (m) =>
        m.claim_type === claim.claim_type &&
        (!matchAspect || m.aspect === claim.aspect),
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
