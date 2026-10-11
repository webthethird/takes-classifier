// Cluster scoring, contested-detection, and representative-cast selection.
//
// Extracted from feed.ts so the identity logic is unit-testable — it has a
// genuinely subtle edge case (see bothSidesOf) that was wrong once already.

import type { RawCast } from "./corpus.js";
import type { Claim } from "./schema.js";

/* ───────────────────────────── Weights ─────────────────────────────── */
//
// The product promise is "here are opinions you COULD challenge", not "here
// are arguments already in progress". So challengeability leads, and the two
// empirical signals corroborate rather than dominate.
//
// These were originally 1.5x and 2.0x, which inverted that: a mediocre
// 0.5-challengeability thread that happened to be contested beat a 0.95 take
// nobody had replied to yet (0.5 x 2.0 x 1.5 = 1.50 vs 0.95).

/// Multiplier when different people hold opposing stances.
export const BOTH_SIDES_BOOST = 1.2;
/// Added per extra cast in a cluster, capped by MAX_SIZE_BOOST.
export const PER_MEMBER_BOOST = 0.15;
export const MAX_SIZE_BOOST = 1.4;
/// Confidence gates rather than boosts: a shaky extraction shouldn't ride a
/// high challengeability score to the top.
export const CONFIDENCE_FLOOR = 0.5;

export type Member = {
  cast: RawCast;
  stance: "yes" | "no";
  similarity: number;
  challengeability: number;
  confidence: number;
  challenge_reason: string;
  /// "claim" = question extracted from this cast (stage 1).
  /// "stance" = cast judged against an existing question (stage 2).
  via: "claim" | "stance";
  /// Stage 2 only: the model's reading of what the parent cast asserts.
  /// Kept so every stance decision can be audited against its inputs.
  stance_parent_says?: string;
};

export type Cluster = {
  id: string;
  question: string;
  claim_type: Claim["claim_type"];
  aspect: string;
  members: Member[];
  score: number;
  both_sides: boolean;
  challenge_reason: string;
};

/* ──────────────────────────── Identity ─────────────────────────────── */

/// Stable per-person key. FID first — usernames are mutable on Farcaster,
/// FIDs are not. Falls back to the cast id, which makes an unidentifiable
/// cast its own "person" rather than silently merging with other unknowns.
export function identity(cast: RawCast): string {
  if (cast.fid !== undefined) return `fid:${cast.fid}`;
  if (cast.username) return `u:${cast.username}`;
  return `cast:${cast.id}`;
}

/// True when at least two DIFFERENT people hold opposing stances.
///
/// The subtlety: it is not enough to find an author who posted only YES and
/// another who posted only NO. Consider Alice:YES, Bob:YES, Bob:NO — Alice
/// and Bob genuinely disagree, but an exclusivity test fails because Bob
/// appears on both sides. The question is whether ANY yes-member and ANY
/// no-member are different people.
///
/// The property being preserved is only that one person arguing with
/// themselves doesn't count. Self-replies are common on Farcaster, and
/// counting them inflated an early measurement from 4 contested to 7.
export function bothSidesOf(members: Member[]): boolean {
  const yesIds = new Set(
    members.filter((m) => m.stance === "yes").map((m) => identity(m.cast)),
  );
  const noIds = new Set(
    members.filter((m) => m.stance === "no").map((m) => identity(m.cast)),
  );
  for (const y of yesIds) {
    for (const n of noIds) {
      if (y !== n) return true;
    }
  }
  return false;
}

/// Distinct people per side, and overall. Cast counts and people counts are
/// different numbers and must never be presented interchangeably — one author
/// posting four times does not make a side four people strong.
export function authorCounts(members: Member[]): {
  yes_authors: number;
  no_authors: number;
  distinct_authors: number;
  yes_casts: number;
  no_casts: number;
} {
  const yes = new Set<string>();
  const no = new Set<string>();
  let yesCasts = 0;
  let noCasts = 0;
  for (const m of members) {
    if (m.stance === "yes") {
      yes.add(identity(m.cast));
      yesCasts++;
    } else {
      no.add(identity(m.cast));
      noCasts++;
    }
  }
  return {
    yes_authors: yes.size,
    no_authors: no.size,
    distinct_authors: new Set([...yes, ...no]).size,
    yes_casts: yesCasts,
    no_casts: noCasts,
  };
}

export function scoreCluster(members: Member[]): {
  score: number;
  bothSides: boolean;
} {
  const peakChallenge = Math.max(...members.map((m) => m.challengeability));
  const peakConfidence = Math.max(...members.map((m) => m.confidence));
  const bothSides = bothSidesOf(members);

  const sizeBoost = Math.min(
    1 + PER_MEMBER_BOOST * (members.length - 1),
    MAX_SIZE_BOOST,
  );
  const confidenceGate =
    CONFIDENCE_FLOOR + (1 - CONFIDENCE_FLOOR) * peakConfidence;

  const score =
    peakChallenge *
    confidenceGate *
    sizeBoost *
    (bothSides ? BOTH_SIDES_BOOST : 1);

  return { score, bothSides };
}

/* ──────────────────── Representative cast selection ────────────────── */

/// Which real cast becomes the face of a feed card.
///
/// Cast-first presentation needs ONE human statement at the top, and it must
/// be a real one — never an AI paraphrase. Preference order:
///   1. stage-1 members (the cast the question was actually extracted from)
///      over stage-2 members (replies judged against someone else's question)
///   2. higher challengeability
///   3. more engagement, as a tiebreak for which cast reads as more alive
///   4. cast id, purely so the choice is deterministic across runs
export function pickRepresentative(members: Member[]): Member {
  const engagement = (m: Member) =>
    (m.cast.replies ?? 0) + (m.cast.recasts ?? 0) + (m.cast.likes ?? 0);
  return [...members].sort((a, b) => {
    if (a.via !== b.via) return a.via === "claim" ? -1 : 1;
    if (b.challengeability !== a.challengeability) {
      return b.challengeability - a.challengeability;
    }
    const e = engagement(b) - engagement(a);
    if (e !== 0) return e;
    return a.cast.id.localeCompare(b.cast.id);
  })[0];
}

/// The strongest reply that disagrees with the representative cast, if any.
/// Showing one real rebuttal conveys a live argument far better than an
/// abstract ratio bar — and unlike `challenge_reason`, it is evidence rather
/// than an AI hypothesis.
export function pickOpposingReply(
  members: Member[],
  representative: Member,
): Member | null {
  const repId = identity(representative.cast);
  const opposed = members.filter(
    (m) => m.stance !== representative.stance && identity(m.cast) !== repId,
  );
  if (opposed.length === 0) return null;
  return [...opposed].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.cast.id.localeCompare(b.cast.id);
  })[0];
}
