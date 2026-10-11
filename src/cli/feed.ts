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
import { fileSource, type CastSource, type RawCast } from "../lib/corpus.js";
import { neynarSource } from "../lib/neynar.js";
import type { Claim, IndexedMarket } from "../lib/schema.js";
import {
  authorCounts,
  pickOpposingReply,
  pickRepresentative,
  scoreCluster,
  type Cluster,
  type Member,
} from "../lib/score.js";

/* ────────────────────────────── Main ───────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  let limit = Infinity;
  let top = 20;
  let matchAspect = false;
  const channels: string[] = [];
  let minReplies = 2;
  let candidates = 100;
  let minChars = 40;
  let includeResolvable = false;
  let pages = 1;
  const searches: string[] = [];
  let trendingWindow: "1d" | "7d" | "30d" | undefined;
  let maxThreads = 15;
  let replyDepth = 1;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") limit = parseInt(args[++i], 10);
    else if (args[i] === "--top") top = parseInt(args[++i], 10);
    else if (args[i] === "--aspect") matchAspect = true;
    else if (args[i] === "--include-resolvable") includeResolvable = true;
    else if (args[i] === "--channel") channels.push(args[++i]);
    else if (args[i] === "--candidates") candidates = parseInt(args[++i], 10);
    else if (args[i] === "--min-chars") minChars = parseInt(args[++i], 10);
    else if (args[i] === "--pages") pages = parseInt(args[++i], 10);
    else if (args[i] === "--search") searches.push(args[++i]);
    else if (args[i] === "--trending-channels")
      trendingWindow = (args[++i] as "1d" | "7d" | "30d") ?? "1d";
    else if (args[i] === "--min-replies") minReplies = parseInt(args[++i], 10);
    else if (args[i] === "--max-threads") maxThreads = parseInt(args[++i], 10);
    else if (args[i] === "--reply-depth") replyDepth = parseInt(args[++i], 10);
    else paths.push(args[i]);
  }

  const live = channels.length > 0 || trendingWindow !== undefined || searches.length > 0;
  if (paths.length === 0 && !live) {
    console.error(
      "Usage:\n" +
        "  pnpm feed [--top N] <corpus.json...>              static corpora\n" +
        "  pnpm feed --channel base --channel crypto         live channels (repeatable)\n" +
        "  pnpm feed --trending-channels 1d                 discover channels dynamically\n" +
        "  pnpm feed --search \"unpopular take\"              semantic search, network-wide\n" +
        "  --include-resolvable                             keep prediction-market claims\n" +
        "Live options: --candidates N --min-replies N --min-chars N --max-threads N --reply-depth N\n" +
        "Live sources need NEYNAR_API_KEY.",
    );
    process.exit(1);
  }

  const sources: CastSource[] = paths.map(fileSource);
  if (live) {
    const apiKey = process.env.NEYNAR_API_KEY;
    if (!apiKey) {
      console.error(
        "NEYNAR_API_KEY is not set. Add it to .env (get a key at https://neynar.com).",
      );
      process.exit(1);
    }
    sources.push(
      neynarSource({
        apiKey,
        feed: { kind: "channel", channelIds: channels },
        candidates,
        minReplies,
        minChars,
        pages,
        searches,
        trendingChannels: trendingWindow
          ? { window: trendingWindow, limit: 10 }
          : undefined,
        maxThreads,
        replyDepth,
      }),
    );
  }

  const casts: RawCast[] = [];
  for (const src of sources) {
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
  let stanceCalls = 0;
  let stancesFound = 0;
  let offTopic = 0;
  let resolvableDropped = 0;
  const rejected: Array<{ id: string; text: string; reason: string }> = [];

  // Group into threads. Replies carry parent_text + thread_root_hash; the
  // static corpora carry neither, so they all fall through to standalone and
  // the old single-stage path is preserved exactly.
  type Thread = { root?: RawCast; replies: RawCast[] };
  const threads = new Map<string, Thread>();
  const standalone: RawCast[] = [];
  for (const c of casts) {
    const root = c.thread_root_hash;
    if (!root) {
      standalone.push(c);
      continue;
    }
    const t = threads.get(root) ?? { replies: [] };
    if (c.parent_text) t.replies.push(c);
    else t.root = c;
    threads.set(root, t);
  }
  console.error(
    `[feed] ${threads.size} threads, ${standalone.length} standalone casts`,
  );

  /// Embed a claim's question, find or create its cluster, and attach a
  /// member. Shared by both stages so clustering behaves identically.
  async function attach(
    claim: Claim,
    cast: RawCast,
    opts: { stance: "yes" | "no"; via: "claim" | "stance"; confidence: number; reason: string },
  ): Promise<string> {
    const emb = await embed(claim.question);
    const match = findMatch(claim, emb, index, { matchAspect });
    const member: Member = {
      cast,
      stance: opts.stance,
      similarity: match.kind === "match" ? match.similarity : 1,
      challengeability: claim.challengeability,
      confidence: opts.confidence,
      challenge_reason: opts.reason,
      via: opts.via,
    };
    if (match.kind === "match") {
      clusters.get(match.market.id)!.members.push(member);
      return match.market.id;
    }
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
    return id;
  }

  /// Stage 1 on a single cast. Returns its claims, or null if not an opinion.
  async function stageOne(cast: RawCast): Promise<Claim[] | null> {
    let result;
    try {
      result = await cache.classify(cast.text, cast.parent_text);
      classified++;
    } catch (e) {
      failed++;
      console.error(`[feed] classify failed for ${cast.id}: ${String(e).slice(0, 120)}`);
      return null;
    }
    if (!result.is_opinion || result.claims.length === 0) {
      rejected.push({ id: cast.id, text: cast.text, reason: result.reason });
      return null;
    }
    opinions++;
    // Drop claims a future fact will settle. Takes has no oracle, so the
    // time-weighted crowd can pay out against someone who turns out to be
    // demonstrably right — those belong on a prediction market.
    const keep = includeResolvable
      ? result.claims
      : result.claims.filter((c) => {
          if (c.externally_resolvable) resolvableDropped++;
          return !c.externally_resolvable;
        });
    if (keep.length === 0) return null;
    return keep;
  }

  // ── Threads: stage 1 on the root, stage 2 on every reply ───────────────
  let threadIdx = 0;
  for (const [rootHash, thread] of threads) {
    threadIdx++;
    const root = thread.root;
    if (!root) {
      // Root wasn't in the pull (filtered out); treat replies as standalone.
      standalone.push(...thread.replies);
      continue;
    }

    const claims = await stageOne(root);
    if (!claims) continue;

    // Every root claim becomes a cluster; the most challengeable one is the
    // thread's question, and that's what replies are judged against. Using
    // one question per thread is deliberate — asking stage 2 about several
    // questions per reply multiplies cost for steeply diminishing returns.
    let primary: { claim: Claim; clusterId: string } | null = null;
    for (const claim of claims) {
      const id = await attach(claim, root, {
        stance: claim.answer,
        via: "claim",
        confidence: claim.confidence,
        reason: claim.challenge_reason,
      });
      if (!primary || claim.challengeability > primary.claim.challengeability) {
        primary = { claim, clusterId: id };
      }
    }
    if (!primary) continue;

    for (const reply of thread.replies) {
      try {
        const st = await cache.stance(primary.claim.question, root.text, reply.text);
        stanceCalls++;
        if (st.stance === "off_topic") {
          offTopic++;
          continue;
        }
        stancesFound++;
        clusters.get(primary.clusterId)!.members.push({
          cast: reply,
          stance: st.stance,
          similarity: 1,
          // A reply inherits the question's challengeability — it didn't
          // raise the question, it answered it.
          challengeability: primary.claim.challengeability,
          confidence: st.confidence,
          challenge_reason: st.reason,
          via: "stance",
        });
      } catch (e) {
        failed++;
        console.error(`[feed] stance failed for ${reply.id}: ${String(e).slice(0, 120)}`);
      }
    }

    if (threadIdx % 10 === 0) {
      console.error(
        `[feed] thread ${threadIdx}/${threads.size} clusters=${clusters.size} stances=${stancesFound} (cache ${cache.hits}h/${cache.misses}m)`,
      );
    }
  }

  // ── Standalone casts: stage 1 only ─────────────────────────────────────
  for (let i = 0; i < standalone.length; i++) {
    const cast = standalone[i];
    const claims = await stageOne(cast);
    if (!claims) continue;
    for (const claim of claims) {
      await attach(claim, cast, {
        stance: claim.answer,
        via: "claim",
        confidence: claim.confidence,
        reason: claim.challenge_reason,
      });
    }
    if (i % 25 === 0 && standalone.length > 25) {
      console.error(
        `[feed] standalone ${i + 1}/${standalone.length} clusters=${clusters.size} (cache ${cache.hits}h/${cache.misses}m)`,
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
      const representative = pickRepresentative(c.members);
      const opposing = pickOpposingReply(c.members, representative);
      return {
        ...c,
        score,
        both_sides: bothSides,
        challenge_reason: best.challenge_reason,
        ...authorCounts(c.members),
        // The real cast that fronts the card in cast-first rendering, plus
        // what Back/Challenge mean relative to ITS stance. Resolved here so
        // the renderer never has to re-derive it (and can't disagree).
        representative_cast_id: representative.cast.id,
        back_means: representative.stance,
        challenge_means: representative.stance === "yes" ? "no" : "yes",
        opposing_cast_id: opposing?.cast.id ?? null,
      };
    })
    .sort((a, b) => b.score - a.score);

  const report = {
    generated_at: new Date().toISOString(),
    sources: paths,
    match_aspect: matchAspect,
    casts_with_thread_context: casts.filter((c) => c.parent_text).length,
    threads: threads.size,
    stance_calls: stanceCalls,
    stances_found: stancesFound,
    stance_off_topic: offTopic,
    resolvable_claims_dropped: resolvableDropped,
    include_resolvable: includeResolvable,
    total_casts: casts.length,
    classified,
    failed,
    opinion_casts: opinions,
    rejected_casts: rejected.length,
    total_clusters: ranked.length,
    multi_member_clusters: ranked.filter((c) => c.members.length > 1).length,
    both_sides_clusters: ranked.filter((c) => c.both_sides).length,
    distinct_author_clusters: ranked.filter(
      (c) => new Set(c.members.map((m) => m.cast.username)).size > 1,
    ).length,
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
  console.error(`  Threads:        ${threads.size}`);
  console.error(`  Resolvable:     ${resolvableDropped} claim(s) dropped (prediction-market material)`);
  console.error(`  Stage-2 calls:  ${stanceCalls} -> ${stancesFound} stances, ${offTopic} off-topic`);
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
