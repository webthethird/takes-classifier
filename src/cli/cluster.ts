#!/usr/bin/env tsx
// Batch CLI: process a corpus of casts and produce clusters.
// Strategy:
//   1. Classify each cast (Stage 1)
//   2. For each opinion-bearing claim, embed the question
//   3. Greedily match against an in-memory market index:
//        - If match found (cosine ≥ 0.85, same claim_type & aspect): join existing market
//        - Else: create new market seeded by this claim
//   4. Output a clusters.json showing which casts joined which markets
//
// Usage:
//   pnpm cluster <corpus.json>          # one of our pulled JSONs
//   pnpm cluster --limit 50 <corpus.json>

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { classifyCast } from "../lib/classify.js";
import { embed } from "../lib/embed.js";
import { findMatch } from "../lib/match.js";
import { Claim, IndexedMarket } from "../lib/schema.js";

type RawCast = {
  ts?: string;
  username?: string;
  text: string;
  parent_hash?: string | null;
  channel?: string | null;
};

type ClusterReport = {
  generated_at: string;
  corpus_path: string;
  total_casts: number;
  classified: number;
  opinion_casts: number;
  total_claims: number;
  total_markets: number;
  markets: Array<{
    id: string;
    question: string;
    claim_type: string;
    aspect: string;
    members: Array<{
      cast_id: string;
      stance: "yes" | "no";
      similarity: number; // 1.0 for the seeding cast
      cast_text: string;
      cast_author: string;
    }>;
  }>;
  rejected: Array<{
    cast_id: string;
    cast_text: string;
    reason: string;
  }>;
};

async function main() {
  const args = process.argv.slice(2);
  let limit = Infinity;
  let corpusPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") {
      limit = parseInt(args[++i], 10);
    } else {
      corpusPath = args[i];
    }
  }
  if (!corpusPath) {
    console.error("Usage: pnpm cluster [--limit N] <corpus.json>");
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(corpusPath, "utf8")) as RawCast[];
  const corpus = raw.slice(0, limit);
  console.error(`[cluster] loaded ${corpus.length} casts from ${corpusPath}`);

  const index: IndexedMarket[] = [];
  const markets = new Map<
    string,
    NonNullable<ClusterReport["markets"][number]>
  >();
  const rejected: ClusterReport["rejected"] = [];
  let classified = 0;
  let opinionCount = 0;
  let claimCount = 0;

  for (let i = 0; i < corpus.length; i++) {
    const c = corpus[i];
    const castId = `${c.username ?? "unknown"}@${c.ts ?? i}`;
    const text = c.text.trim();
    if (!text) continue;

    let result;
    try {
      result = await classifyCast({ text });
      classified++;
    } catch (e) {
      console.error(
        `[cluster] classify failed for ${castId}:`,
        (e as Error).message,
      );
      continue;
    }

    if (!result.is_opinion || result.claims.length === 0) {
      rejected.push({ cast_id: castId, cast_text: text, reason: result.reason });
      if (i % 10 === 0)
        console.error(
          `[cluster] [${i + 1}/${corpus.length}] ${castId}: rejected (${result.reason.slice(0, 60)})`,
        );
      continue;
    }

    opinionCount++;
    for (const claim of result.claims) {
      claimCount++;
      const claimEmbedding = await embed(claim.question);
      const outcome = findMatch(claim, claimEmbedding, index);

      let marketId: string;
      let similarity = 1.0;
      if (outcome.kind === "match") {
        marketId = outcome.market.id;
        similarity = outcome.similarity;
      } else {
        // For prototype: ambiguous → still create new (in production we'd ask user)
        marketId = `mkt_${index.length + 1}`;
        const m: IndexedMarket = {
          id: marketId,
          question: claim.question,
          claim_type: claim.claim_type,
          aspect: claim.aspect,
          embedding: claimEmbedding,
          seeded_by_cast: castId,
        };
        index.push(m);
        markets.set(marketId, {
          id: marketId,
          question: claim.question,
          claim_type: claim.claim_type,
          aspect: claim.aspect,
          members: [],
        });
      }
      const market = markets.get(marketId)!;
      market.members.push({
        cast_id: castId,
        stance: claim.answer,
        similarity,
        cast_text: text,
        cast_author: c.username ?? "unknown",
      });
    }

    if (i % 10 === 0) {
      console.error(
        `[cluster] [${i + 1}/${corpus.length}] ${castId}: ${result.claims.length} claim(s), markets=${markets.size}`,
      );
    }
  }

  const report: ClusterReport = {
    generated_at: new Date().toISOString(),
    corpus_path: corpusPath,
    total_casts: corpus.length,
    classified,
    opinion_casts: opinionCount,
    total_claims: claimCount,
    total_markets: markets.size,
    markets: Array.from(markets.values()).sort(
      (a, b) => b.members.length - a.members.length,
    ),
    rejected,
  };

  const outPath = `clusters_${basename(corpusPath, ".json")}_${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.error("");
  console.error(`=== Done ===`);
  console.error(`  Casts:           ${corpus.length}`);
  console.error(`  Classified:      ${classified}`);
  console.error(`  Opinion casts:   ${opinionCount}`);
  console.error(`  Claims:          ${claimCount}`);
  console.error(`  Markets:         ${markets.size}`);
  console.error(
    `  Multi-member:    ${Array.from(markets.values()).filter((m) => m.members.length > 1).length}`,
  );
  console.error(`  Report written:  ${outPath}`);

  // Print top clusters to stdout for quick eyeballing
  console.log("");
  console.log("=== Top markets by member count ===");
  for (const m of report.markets.slice(0, 10)) {
    console.log(`\n[${m.members.length} members] ${m.question}`);
    console.log(`  type=${m.claim_type}  aspect=${m.aspect}`);
    for (const member of m.members.slice(0, 5)) {
      console.log(
        `   ${member.stance.toUpperCase()} (sim=${member.similarity.toFixed(2)}) @${member.cast_author}: ${member.cast_text.slice(0, 100).replace(/\n/g, " ")}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
