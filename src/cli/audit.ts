#!/usr/bin/env tsx
// Prints every stage-2 stance decision with the inputs that produced it, so
// inverted stances can be caught by reading rather than by trusting a count.
//
//   pnpm audit-stances feed_<ts>.json
//   pnpm audit-stances --self feed_<ts>.json   # only self-replies, the risky case

import { readFileSync } from "node:fs";

type M = {
  cast: { id: string; text: string; username?: string; fid?: number; parent_text?: string };
  stance: string;
  confidence: number;
  challenge_reason: string;
  via?: string;
  stance_parent_says?: string;
};

const args = process.argv.slice(2);
const selfOnly = args.includes("--self");
const path = args.find((a) => !a.startsWith("--"));
if (!path) {
  console.error("Usage: pnpm audit-stances [--self] <report.json>");
  process.exit(1);
}

const r = JSON.parse(readFileSync(path, "utf8")) as {
  feed: Array<{ question: string; representative_cast_id?: string; members: M[] }>;
};

let shown = 0;
let flagged = 0;
for (const c of r.feed) {
  const rep = c.members.find((m) => m.cast.id === c.representative_cast_id) ?? c.members[0];
  const stage2 = c.members.filter((m) => m.via === "stance");
  if (stage2.length === 0) continue;

  const rows = stage2.filter((m) => {
    const isSelf = m.cast.fid !== undefined && m.cast.fid === rep.cast.fid;
    return selfOnly ? isSelf : true;
  });
  if (rows.length === 0) continue;

  console.log(`\n\x1b[1m${c.question}\x1b[0m`);
  console.log(`  ROOT @${rep.cast.username} [${rep.stance}]: ${rep.cast.text.slice(0, 100).replace(/\n/g, " ")}`);
  for (const m of rows) {
    shown++;
    const isSelf = m.cast.fid !== undefined && m.cast.fid === rep.cast.fid;
    const contradictsSelf = isSelf && m.stance !== rep.stance;
    if (contradictsSelf) flagged++;
    const mark = contradictsSelf ? "\x1b[33m⚠ SELF-CONTRADICTION\x1b[0m" : "";
    console.log(`\n  @${m.cast.username} [${m.stance}] conf=${m.confidence.toFixed(2)}${isSelf ? " (same author)" : ""} ${mark}`);
    console.log(`    replying to: ${(m.cast.parent_text ?? "(root)").slice(0, 90).replace(/\n/g, " ")}`);
    console.log(`    said:        ${m.cast.text.slice(0, 90).replace(/\n/g, " ")}`);
    if (m.stance_parent_says) console.log(`    parent reads as: ${m.stance_parent_says.slice(0, 110)}`);
    console.log(`    because:     ${m.challenge_reason.slice(0, 110)}`);
  }
}
console.log(`\n${shown} stage-2 decisions, ${flagged} where an author contradicts their own root.`);
