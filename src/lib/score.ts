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

/// Challengeability is quantized into bands before ranking, and corroboration
/// only reorders WITHIN a band. Multiplying instead let corroboration leapfrog
/// tiers: measured on a live pull, a 0.60-challengeability thread outranked a
/// 0.70 unchallenged take, and 9 of 29 ranking inversions were a thread
/// beating a more challengeable take that had no replies.
///
/// That was structural, not a weighting accident. A cast with zero replies
/// cannot accumulate members, so a size multiplier locks an entire lane out of
/// the top of the feed — the lane holding exactly what the product promises to
/// surface: opinions you COULD challenge, not arguments already underway.
///
/// 0.1 bands: a 0.70 take always outranks a 0.60 take; 0.72 vs 0.75 is noise
/// and gets settled by evidence of real disagreement.
export const CHALLENGE_BAND = 0.1;
/// Corroboration within a band, in band-fraction units so it can never cross
/// a band boundary. Different people on opposing sides is the strongest
/// evidence the question is live.
export const BOTH_SIDES_CREDIT = 0.5;
/// Per additional DISTINCT PERSON on the question (not per cast — one author
/// posting four times is not four people).
export const PER_AUTHOR_CREDIT = 0.12;
export const MAX_AUTHOR_CREDIT = 0.4;
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
  const people = new Set(members.map((m) => identity(m.cast))).size;

  // Confidence gates the challengeability estimate before banding, so a
  // shaky extraction drops a tier rather than riding one.
  const gated =
    peakChallenge * (CONFIDENCE_FLOOR + (1 - CONFIDENCE_FLOOR) * peakConfidence);

  const band = Math.floor(gated / CHALLENGE_BAND);
  const credit = Math.min(
    1,
    (bothSides ? BOTH_SIDES_CREDIT : 0) +
      Math.min(PER_AUTHOR_CREDIT * (people - 1), MAX_AUTHOR_CREDIT),
  );

  // Band dominates; credit only orders within it. Keeping the result on the
  // same 0..1-ish scale as before so existing report output stays readable.
  const score = (band + credit) * CHALLENGE_BAND;

  return { score, bothSides };
}

/* ─────────────────── Stance reconciliation (stage 2) ───────────────── */

/// When the model records a definite parent stance AND a definite agreement,
/// the reply's stance follows mechanically. Deriving it instead of trusting
/// the model's own verdict closes the one failure mode that kept producing
/// invented disagreements: correct reasoning followed by an inverted answer,
/// because a negatively-framed question ("...without full understanding?")
/// flipped polarity somewhere between the reasoning and the verdict.
///
/// Returns the model's stance untouched when the intermediates don't pin it
/// down — `none` parent stance, `neither` agreement, or an off_topic call,
/// which is a judgment the derivation can't make.
export function reconcileStance(
  r: {
    parent_stance: "yes" | "no" | "none";
    agreement: "agree" | "disagree" | "neither";
    stance: "yes" | "no" | "off_topic";
    explicit_reversal?: boolean;
  },
  /// Supplied when the reply is by the root's author, with the root's stance.
  /// An author elaborating in their own thread defends their position; every
  /// self-reply assigned an opposing stance in the sample we checked was
  /// wrong. So without an explicit retraction, they keep their own stance —
  /// a contrastive opener ("and yet...") is not a reversal.
  self?: { rootStance: "yes" | "no" },
): { stance: "yes" | "no" | "off_topic"; corrected: boolean } {
  if (r.stance === "off_topic") return { stance: "off_topic", corrected: false };
  if (self && !r.explicit_reversal) {
    return { stance: self.rootStance, corrected: r.stance !== self.rootStance };
  }
  if (r.parent_stance === "none" || r.agreement === "neither") {
    return { stance: r.stance, corrected: false };
  }
  const derived =
    r.agreement === "agree"
      ? r.parent_stance
      : r.parent_stance === "yes"
        ? "no"
        : "yes";
  return { stance: derived, corrected: derived !== r.stance };
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
  // Confidence alone picks one-line reactions over developed counter-arguments.
  // Weight it by how substantive the rebuttal is, saturating at ~200 chars so
  // long rambles don't win on length alone.
  const weight = (m: Member) =>
    m.confidence * Math.min(1, 0.4 + m.cast.text.trim().length / 200);
  return [...opposed].sort((a, b) => {
    const w = weight(b) - weight(a);
    if (Math.abs(w) > 1e-9) return w;
    return a.cast.id.localeCompare(b.cast.id);
  })[0];
}
