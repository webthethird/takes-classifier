#!/usr/bin/env tsx
// Builds data/image-cases.json for `pnpm eval-images`: casts with images, taken from a
// takes-client's local databases (its classifications and cast stores), in two groups:
//
//   A  image casts the client classified as opinions: does seeing the image change the question?
//   B  short image casts it classified as NOT opinions: does the image make some debatable?
//
// Every image URL is checked to serve image/*; casts with none that do are skipped.
//
//   pnpm image-cases <takes.sqlite> <warp.sqlite> [--must <text fragment>]...

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const must = args.flatMap((a, i) => (args[i - 1] === "--must" ? [a] : []));
const [takesDb, warpDb] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--must");
if (!takesDb || !warpDb) {
  console.error("Usage: pnpm image-cases <takes.sqlite> <warp.sqlite> [--must <text fragment>]...");
  process.exit(1);
}
const PER_GROUP = 20;
const SHORT = 100;

type Row = { hash: string; text: string; embeds: string; claim: string | null };
const rows: Row[] = JSON.parse(
  execFileSync("sqlite3", ["-json", takesDb, `attach '${warpDb}' as w;
    select k.hash, coalesce(a.text, c.text) text, coalesce(a.embeds, c.embeds) embeds, k.claim
      from classifications k
      left join archive_casts a on a.hash = k.hash
      left join w.casts c on c.hash = k.hash
     where coalesce(a.embeds, c.embeds) is not null
       and k.prompt_version = (select prompt_version from classifications order by classified_ts desc limit 1)
     order by k.hash`], { maxBuffer: 1 << 28 }).toString() || "[]",
);

/** URLs that look like images; confirmed by fetching below. */
const imageLike = (u: string) =>
  /^https:\/\/(imagedelivery\.net|i\.imgur\.com)\//.test(u) || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(u);
const candidates = (r: Row) =>
  (JSON.parse(r.embeds) as Array<{ kind: string; url?: string }>).flatMap(e => (e.kind === "url" && e.url && imageLike(e.url) ? [e.url] : []));

const isImage = async (url: string): Promise<boolean> => {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(url, { method, redirect: "follow", headers: method === "GET" ? { range: "bytes=0-0" } : {}, signal: AbortSignal.timeout(10_000) });
      await res.body?.cancel();
      if (res.ok || res.status === 206) return (res.headers.get("content-type") ?? "").startsWith("image/");
    } catch { /* try the next method */ }
  }
  return false;
};

type Case = { group: "A" | "B"; hash: string; text: string; images: string[]; clientQuestion: string | null };
const pick = async (group: "A" | "B", pool: Row[]): Promise<Case[]> => {
  const out: Case[] = [];
  // Required casts first, then the pool in hash order (deterministic).
  const ordered = [...pool.filter(r => must.some(m => r.text.includes(m))), ...pool.filter(r => !must.some(m => r.text.includes(m)))];
  for (const r of ordered) {
    if (out.length >= PER_GROUP) break;
    const urls = candidates(r);
    if (urls.length === 0) continue;
    const ok = (await Promise.all(urls.map(async u => ((await isImage(u)) ? u : null)))).filter((u): u is string => u !== null);
    if (ok.length === 0) continue;
    out.push({ group, hash: r.hash, text: r.text, images: ok, clientQuestion: r.claim ? (JSON.parse(r.claim) as { question: string }).question : null });
  }
  return out;
};

const withImages = rows.filter(r => candidates(r).length > 0);
const cases = [
  ...(await pick("A", withImages.filter(r => r.claim !== null))),
  ...(await pick("B", withImages.filter(r => r.claim === null && r.text.trim().length <= SHORT))),
];
writeFileSync("data/image-cases.json", JSON.stringify(cases, null, 2) + "\n");
console.log(`${withImages.length} classified casts have image-like embeds; wrote ${cases.length} cases (A ${cases.filter(c => c.group === "A").length}, B ${cases.filter(c => c.group === "B").length}) to data/image-cases.json`);
for (const m of must) console.log(`  --must "${m}": ${cases.some(c => c.text.includes(m)) ? "included" : "NOT FOUND"}`);
