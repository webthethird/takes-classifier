#!/usr/bin/env tsx
// Image eval: classifies each case in data/image-cases.json twice, without and with its images,
// and writes the two side by side for reading. Two Claude calls per case.
//
//   pnpm eval-images [--model claude-haiku-5-5] [--effort low] [--control]
//
// --control runs both arms WITHOUT images: how much the answer changes between two identical
// runs. Read the image run against it: only changes beyond that are the images' doing.
//
// Defaults are what the takes-client Worker runs (claude-haiku-5-5, effort low), not this repo's
// default model: the question is what images would change in the feed people see.

import { readFileSync, writeFileSync } from "node:fs";
import { classifyCast } from "../lib/classify.js";
import type { ClassifyResult } from "../lib/schema.js";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const model = flag("model") ?? "claude-haiku-5-5";
const effort = (flag("effort") ?? "low") as "low" | "medium" | "high";
const control = args.includes("--control");

type Case = { group: "A" | "B"; hash: string; text: string; images: string[]; clientQuestion: string | null };
const cases: Case[] = JSON.parse(readFileSync("data/image-cases.json", "utf8"));

type Arm = { ok: true; r: ClassifyResult } | { ok: false; error: string };
const run = async (c: Case, images: boolean): Promise<Arm> => {
  try {
    return { ok: true, r: await classifyCast({ text: c.text, model, effort, ...(images ? { images: c.images } : {}) }) };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
};

const results: Array<{ c: Case; without: Arm; withImages: Arm }> = [];
const queue = [...cases];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let c = queue.shift(); c; c = queue.shift()) {
    const [without, withImages] = await Promise.all([run(c, false), run(c, !control)]);
    results.push({ c, without, withImages });
  }
}));
results.sort((a, b) => a.c.group.localeCompare(b.c.group) || a.c.hash.localeCompare(b.c.hash));

const show = (a: Arm) => {
  if (!a.ok) return `ERROR ${a.error}`;
  if (!a.r.is_opinion || a.r.claims.length === 0) return `not an opinion (${a.r.reason})`;
  return a.r.claims.map(k => `"${k.question}" → ${k.answer} (challengeability ${k.challengeability})`).join("; ");
};
const opinion = (a: Arm) => a.ok && a.r.is_opinion && a.r.claims.length > 0;
const question = (a: Arm) => (a.ok && a.r.claims[0]?.question) || null;

const lines = [`# Image eval${control ? " (CONTROL: both arms without images)" : ""}: ${model}, effort ${effort}, ${new Date().toISOString()}`, ""];
for (const g of ["A", "B"] as const) {
  const rs = results.filter(x => x.c.group === g);
  const flipsIn = rs.filter(x => !opinion(x.without) && opinion(x.withImages)).length;
  const flipsOut = rs.filter(x => opinion(x.without) && !opinion(x.withImages)).length;
  const changed = rs.filter(x => opinion(x.without) && opinion(x.withImages) && question(x.without) !== question(x.withImages)).length;
  const errors = rs.filter(x => !x.withImages.ok).length;
  const summary = `Group ${g} (${rs.length}): became an opinion with images ${flipsIn}, stopped being one ${flipsOut}, question changed ${changed}, image request failed ${errors}`;
  console.log(summary);
  lines.push(`## ${summary}`, "");
  for (const { c, without, withImages } of rs) {
    lines.push(`### ${c.hash}`, "", `> ${c.text.replace(/\n+/g, " ").slice(0, 400)}`, "");
    lines.push(...c.images.map(u => `- image: ${u}`));
    if (c.clientQuestion) lines.push(`- client's question today: "${c.clientQuestion}"`);
    lines.push(`- **without images:** ${show(without)}`, `- **with images:** ${show(withImages)}`, "");
  }
}
const out = `eval-images_${control ? "control_" : ""}${Date.now()}.md`;
writeFileSync(out, lines.join("\n"));
console.log(`wrote ${out}`);
