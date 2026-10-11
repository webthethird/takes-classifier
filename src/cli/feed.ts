#!/usr/bin/env tsx
// Builds the ranked "worth challenging" feed from one or more cast corpora.
//
// Pipeline:
//   1. Classify every cast (rejects news, spam, social, questions)
//   2. Embed each surviving claim's question and greedily cluster, so the
//      same argument from five people is ONE feed row, not five
//   3. Rank clusters — see scoring notes below
//   4. Emit feed_<timestamp>.json and a terminal summary
//
// Usage:
//   pnpm feed data/politics.json
//   pnpm feed --limit 20 data/snap.json data/trump.json
//   pnpm feed --top 20 data/*.json
//   pnpm feed --aspect data/snap.json     # stricter matching, see note below
//
// Matching: aspect filtering is OFF by default, matching the miniapp. Measured
// over all four corpora (348 casts): aspect-on gave 96 clusters / 5
// multi-member, aspect-off gave 93 / 7. The classifier drifts between
// near-identical tags ("airdrop fairness" vs "fairness") and a mismatch
// silently blocks an otherwise-good merge. `--aspect` restores the strict
// behavior if you want to re-measure.

import { writeFileSync } from "node:fs";
import { ClassifyCache } from "../lib/cache.js";
import { embed } from "../lib/embed.js";
import { findMatch } from "../lib/match.js";
import { fileSource, type RawCast } from "../lib/corpus.js";
import type { Claim, IndexedMarket } from "../lib/schema.js";

/* ───────────────────────────── Scoring ─────────────────────────────── */
//
// Challengeability from the classifier is the base, but the two empirical
// signals are better than the model's judgment and get to override it:
//
//   - A cluster where people have ALREADY taken opposing sides is proven
//     contested. No model opinion beats observed disagreement.
//   - A cluster several casts deep is a live argument rather than one
//     person's passing thought.
//
// Confidence acts as a gate, not a booster: a shaky extraction shouldn't
// ride a high challengeability score into the top of the feed.

/// Multiplier when a cluster already contains both a yes and a no stance.
const BOTH_SIDES_BOOST = 1.5;
/// Added per extra cast in a cluster, capped by MAX_SIZE_BOOST.
const PER_MEMBER_BOOST = 0.3;
const MAX_SIZE_BOOST = 2.0;
/// Confidence is folded in at half weight so it can dampen but not dominate.
const CONFIDENCE_FLOOR = 0.5;

type Member = {
  cast: RawCast;
  stance: "yes" | "no";
  similarity: number;
  challengeability: number;
  confidence: number;
  challenge_reason: string;
};

type Cluster = {
  id: string;
  question: string;
  claim_type: Claim["claim_type"];
  aspect: string;
  members: Member[];
  score: number;
  both_sides: boolean;
  challenge_reason: string;
};

function scoreCluster(members: Member[]): { score: number; bothSides: boolean } {
  const peakChallenge = Math.max(...members.map((m) => m.challengeability));
  const peakConfidence = Math.max(...members.map((m) => m.confidence));
  const bothSides =
    members.some((m) => m.stance === "yes") &&
    members.some((m) => m.stance === "no");

  const sizeBoost = Math.min(
    1 + PER_MEMBER_BOOST * (members.length - 1),
    MAX_SIZE_BOOST,
  );
  const confidenceGate =
    CONFIDENCE_FLOOR + (1 - CONFIDENCE_FLOOR) * peakConfidence;

  const score =
    peakChallenge * confidenceGate * sizeBoost * (bothSides ? BOTH_SIDES_BOOST : 1);

  return { score, bothSides };
}

/* ────────────────────────────── Main ───────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  let limit = Infinity;
  let top = 20;
  let matchAspect = false;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") limit = parseInt(args[++i], 10);
    else if (args[i] === "--top") top = parseInt(args[++i], 10);
    else if (args[i] === "--aspect") matchAspect = true;
    else paths.push(args[i]);
  }
  if (paths.length === 0) {
    console.error("Usage: pnpm feed [--limit N] [--top N] <corpus.json...>");
    process.exit(1);
  }

  const casts: RawCast[] = [];
  for (const p of paths) {
    const src = fileSource(p);
    const loaded = await src.load(limit);
    console.error(`[feed] ${src.name}: ${loaded.length} casts`);
    casts.push(...loaded);
  }

  const cache = new ClassifyCache();
  cache.installExitHandlers();
  console.error(`[feed] classify cache: ${cache.size} entries`);

  const index: IndexedMarket[] = [];
  const clusters = new Map<string, Cluster>();
  let classified = 0;
  let opinions = 0;
  let failed = 0;
  const rejected: Array<{ id: string; text: string; reason: string }> = [];

  for (let i = 0; i < casts.length; i++) {
    const cast = casts[i];
    let result;
    try {
      result = await cache.classify(cast.text);
      classified++;
    } catch (e) {
      failed++;
      console.error(`[feed] classify failed for ${cast.id}: ${String(e).slice(0, 120)}`);
      continue;
    }

    if (!result.is_opinion || result.claims.length === 0) {
      rejected.push({ id: cast.id, text: cast.text, reason: result.reason });
      continue;
    }
    opinions++;

    for (const claim of result.claims) {
      const emb = await embed(claim.question);
      const match = findMatch(claim, emb, index, { matchAspect });

      const member: Member = {
        cast,
        stance: claim.answer,
        similarity: match.kind === "match" ? match.similarity : 1,
        challengeability: claim.challengeability,
        confidence: claim.confidence,
        challenge_reason: claim.challenge_reason,
      };

      if (match.kind === "match") {
        clusters.get(match.market.id)!.members.push(member);
      } else {
        const id = `c${clusters.size + 1}`;
        index.push({
          id,
          question: claim.question,
          claim_type: claim.claim_type,
          aspect: claim.aspect,
          embedding: emb,
          seeded_by_cast: cast.id,
        });
        clusters.set(id, {
          id,
          question: claim.question,
          claim_type: claim.claim_type,
          aspect: claim.aspect,
          members: [member],
          score: 0,
          both_sides: false,
          challenge_reason: claim.challenge_reason,
        });
      }
    }

    if (i % 10 === 0) {
      console.error(
        `[feed] [${i + 1}/${casts.length}] clusters=${clusters.size} opinions=${opinions} (cache ${cache.hits}h/${cache.misses}m)`,
      );
    }
  }

  cache.flush();

  const ranked = [...clusters.values()]
    .map((c) => {
      const { score, bothSides } = scoreCluster(c.members);
      // Lead with the reason from the most challengeable member — it's the
      // one that framed the disagreement most sharply.
      const best = [...c.members].sort(
        (a, b) => b.challengeability - a.challengeability,
      )[0];
      return {
        ...c,
        score,
        both_sides: bothSides,
        challenge_reason: best.challenge_reason,
      };
    })
    .sort((a, b) => b.score - a.score);

  const report = {
    generated_at: new Date().toISOString(),
    sources: paths,
    match_aspect: matchAspect,
    total_casts: casts.length,
    classified,
    failed,
    opinion_casts: opinions,
    rejected_casts: rejected.length,
    total_clusters: ranked.length,
    multi_member_clusters: ranked.filter((c) => c.members.length > 1).length,
    both_sides_clusters: ranked.filter((c) => c.both_sides).length,
    feed: ranked.slice(0, top),
    rejected,
  };

  const out = `feed_${Date.now()}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.error("\n=== Done ===");
  console.error(`  Casts:          ${casts.length}`);
  console.error(`  Opinions:       ${opinions}  (rejected ${rejected.length}, failed ${failed})`);
  console.error(`  Clusters:       ${ranked.length}`);
  console.error(`  Multi-member:   ${report.multi_member_clusters}`);
  console.error(`  Both sides:     ${report.both_sides_clusters}`);
  console.error(`  Written:        ${out}`);

  console.log(`\n=== Top ${Math.min(top, ranked.length)} by score ===`);
  for (const c of ranked.slice(0, top)) {
    const flags = [
      c.both_sides ? "BOTH SIDES" : null,
      c.members.length > 1 ? `${c.members.length} casts` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    console.log(`\n[${c.score.toFixed(2)}] ${c.question}${flags ? `  (${flags})` : ""}`);
    console.log(`  ${c.challenge_reason}`);
    for (const m of c.members.slice(0, 3)) {
      console.log(
        `   ${m.stance.toUpperCase()} @${m.cast.username ?? "unknown"}: ${m.cast.text.slice(0, 90).replace(/\n/g, " ")}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
