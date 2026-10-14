import { Claim, IndexedMarket, MatchResult } from "./schema.js";
import { cosine } from "./embed.js";

/// Cosine similarity at which two questions are the same market.
///
/// Lowered from 0.85 after near-duplicate cards reached the feed: "Is the new
/// press secretary competent?" and "...performing well?" sat at 0.843, just
/// under the old bar. Measured over 208 pooled questions, the [0.80, 0.85)
/// band is overwhelmingly genuine duplicates — "diesel deal strategically
/// significant" / "fuel deal geopolitically significant",  "attract the most
/// builders" / "earn the most builders". The clearest false merge in that band
/// (Raikkonen championship vs Singapore GP) is a predictive claim the
/// externally-resolvable filter drops before it can reach a card.
///
/// Override with MATCH_THRESHOLD to re-measure.
export const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD ?? 0.82);
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
