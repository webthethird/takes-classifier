#!/usr/bin/env tsx
// Renders a feed_<timestamp>.json report into a standalone HTML page.
//
// Two layouts, same data, so they can be compared fairly:
//
//   --layout question   the original. Canonical question is the headline,
//                       source casts are hidden behind a disclosure.
//   --layout cast       cast-first. A real person's words lead; the
//                       generated question is subordinate.
//
// The A/B question is NOT which looks nicer. It is: which one makes someone
// want to back or challenge a specific real person?
//
// Usage:
//   pnpm render-feed --layout cast --out b.html feed_123.json
//   pnpm render-feed --layout question --out a.html feed_123.json

import { readFileSync, writeFileSync } from "node:fs";

type Cast = {
  id: string;
  text: string;
  username?: string;
  fid?: number;
  ts?: string;
  channel?: string | null;
  url?: string;
  replies?: number;
  recasts?: number;
  likes?: number;
};

type Member = {
  cast: Cast;
  stance: "yes" | "no";
  challengeability: number;
  confidence: number;
  challenge_reason: string;
  via?: "claim" | "stance";
};

type Cluster = {
  id: string;
  question: string;
  claim_type: string;
  aspect: string;
  members: Member[];
  score: number;
  both_sides: boolean;
  challenge_reason: string;
  yes_casts?: number;
  no_casts?: number;
  yes_authors?: number;
  no_authors?: number;
  distinct_authors?: number;
  representative_cast_id?: string;
  back_means?: "yes" | "no";
  challenge_means?: "yes" | "no";
  opposing_cast_id?: string | null;
};

type Report = {
  generated_at: string;
  sources: string[];
  total_casts: number;
  opinion_casts: number;
  rejected_casts: number;
  total_clusters: number;
  multi_member_clusters: number;
  both_sides_clusters: number;
  threads?: number;
  resolvable_claims_dropped?: number;
  feed: Cluster[];
};

type Layout = "question" | "cast";

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function shortDate(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/// Falls back to the first member if the resolved id is missing, so an older
/// report still renders rather than throwing.
function representativeOf(c: Cluster): Member {
  return (
    c.members.find((m) => m.cast.id === c.representative_cast_id) ?? c.members[0]
  );
}

function engagementLine(cast: Cast): string {
  const bits: string[] = [];
  if (cast.likes !== undefined) bits.push(`${cast.likes} likes`);
  if (cast.recasts !== undefined) bits.push(`${cast.recasts} recasts`);
  if (cast.replies !== undefined) bits.push(`${cast.replies} replies`);
  return bits.join(" · ");
}

function provenance(cast: Cast): string {
  const parts = [
    `<span class="handle">@${esc(cast.username ?? "unknown")}</span>`,
    cast.channel ? `<span class="muted">/${esc(cast.channel)}</span>` : "",
    `<span class="muted">${esc(shortDate(cast.ts))}</span>`,
    cast.url
      ? `<a class="src" href="${esc(cast.url)}" target="_blank" rel="noopener">on Farcaster ↗</a>`
      : "",
  ].filter(Boolean);
  return parts.join('<span class="dot">·</span>');
}

/* ───────────────────────── Layout A: question-first ─────────────────── */

function questionCard(c: Cluster, rank: number): string {
  const yesCasts = c.yes_casts ?? c.members.filter((m) => m.stance === "yes").length;
  const noCasts = c.no_casts ?? c.members.filter((m) => m.stance === "no").length;

  const split = c.both_sides
    ? `<div class="split" role="img" aria-label="${yesCasts} yes casts, ${noCasts} no casts">
         <span class="split-yes" style="flex:${yesCasts}"></span>
         <span class="split-no" style="flex:${noCasts}"></span>
       </div>
       <p class="split-caption"><span class="k-yes">${yesCasts} yes</span> · <span class="k-no">${noCasts} no</span> <span class="muted">casts, from ${c.distinct_authors ?? "?"} people</span></p>`
    : "";

  const casts = c.members
    .map(
      (m) => `<li class="cast cast--${m.stance}">
        <div class="cast-head">
          ${provenance(m.cast)}
          <span class="stance stance--${m.stance}">${m.stance}</span>
          ${m.via === "stance" ? '<span class="via">reply</span>' : '<span class="via via--root">opening take</span>'}
        </div>
        <p class="cast-text">${esc(m.cast.text)}</p>
      </li>`,
    )
    .join("\n");

  return `<article class="card">
    <header class="card-head">
      <span class="rank">${String(rank).padStart(2, "0")}</span>
      <div class="meta">
        <span class="tag">${esc(c.claim_type)}</span>
        <span class="tag tag--quiet">${esc(c.aspect)}</span>
        ${c.both_sides ? '<span class="tag tag--hot">contested</span>' : ""}
      </div>
      <span class="score" title="ranking score">${c.score.toFixed(2)}</span>
    </header>

    <h2 class="question">${esc(c.question)}</h2>
    <p class="reason"><span class="ai-tag">AI hypothesis</span> ${esc(c.challenge_reason)}</p>

    ${split}

    <details class="evidence">
      <summary>${c.members.length} source cast${c.members.length === 1 ? "" : "s"}</summary>
      <ul class="casts">${casts}</ul>
    </details>

    <div class="actions">
      <button class="btn btn--yes" type="button">Back yes</button>
      <button class="btn btn--no" type="button">Back no</button>
      <button class="btn btn--ghost" type="button">Challenge</button>
    </div>
  </article>`;
}

/* ─────────────────────────── Layout B: cast-first ───────────────────── */

function castCard(c: Cluster, rank: number): string {
  const rep = representativeOf(c);
  const opposing = c.opposing_cast_id
    ? c.members.find((m) => m.cast.id === c.opposing_cast_id)
    : null;
  const others = c.members.filter(
    (m) => m.cast.id !== rep.cast.id && m.cast.id !== opposing?.cast.id,
  );
  const engagement = engagementLine(rep.cast);

  // Back/Challenge are relative to what THIS PERSON said. A user should never
  // need to understand canonical positive framing to disagree with someone.
  const backMeans = c.back_means ?? rep.stance;
  const challengeMeans = c.challenge_means ?? (rep.stance === "yes" ? "no" : "yes");

  const opposingBlock = opposing
    ? `<div class="rebuttal">
         <p class="rebuttal-label">Someone already disagrees</p>
         <div class="cast-head">${provenance(opposing.cast)}</div>
         <p class="cast-text">${esc(opposing.cast.text)}</p>
       </div>`
    : `<p class="reason"><span class="ai-tag">AI hypothesis</span> ${esc(c.challenge_reason)}</p>`;

  const related =
    others.length > 0
      ? `<details class="evidence">
           <summary>${others.length} related cast${others.length === 1 ? "" : "s"} on the same question${
             c.distinct_authors ? ` · ${c.distinct_authors} people` : ""
           }</summary>
           <ul class="casts">${others
             .map(
               (m) => `<li class="cast cast--${m.stance}">
                 <div class="cast-head">
                   ${provenance(m.cast)}
                   <span class="stance stance--${m.stance}">${m.stance}</span>
                 </div>
                 <p class="cast-text">${esc(m.cast.text)}</p>
               </li>`,
             )
             .join("\n")}</ul>
         </details>`
      : "";

  return `<article class="card card--cast">
    <header class="cast-top">
      <div class="cast-head">${provenance(rep.cast)}</div>
      <span class="rank">${String(rank).padStart(2, "0")}</span>
    </header>

    <blockquote class="said">${esc(rep.cast.text)}</blockquote>
    ${engagement ? `<p class="engagement">${esc(engagement)}</p>` : ""}

    <div class="identified">
      <p class="identified-label">✦ Takes identified</p>
      <p class="identified-q">${esc(c.question)}</p>
      <p class="identified-meta">
        @${esc(rep.cast.username ?? "unknown")} is arguing
        <strong class="k-${rep.stance}">${rep.stance}</strong>
        ${c.both_sides ? '<span class="tag tag--hot">contested</span>' : ""}
      </p>
    </div>

    ${opposingBlock}

    <div class="actions">
      <button class="btn btn--back" type="button">
        Back @${esc(rep.cast.username ?? "this take")}
        <span class="btn-sub">${backMeans}</span>
      </button>
      <button class="btn btn--challenge" type="button">
        Challenge
        <span class="btn-sub">${challengeMeans}</span>
      </button>
    </div>

    ${related}
  </article>`;
}

/* ──────────────────────────────── Page ──────────────────────────────── */

function render(r: Report, layout: Layout): string {
  const isCast = layout === "cast";
  const title = isCast ? "Takes — who said what" : "Takes — worth challenging";
  const heading = isCast
    ? "Opinions worth challenging"
    : "Opinions worth challenging";
  const standfirst = isCast
    ? "Real Farcaster casts, each with the canonical yes/no question Takes derived from it. Backing or challenging is relative to what that person actually said. No staking — this is testing one thing only."
    : "Real Farcaster casts, classified into canonical yes/no questions, clustered so the same argument appears once, and ranked by how much they invite someone to take the other side. No staking — this is testing one thing only.";

  const cards = r.feed
    .map((c, i) => (isCast ? castCard(c, i + 1) : questionCard(c, i + 1)))
    .join("\n");

  return `<title>${title}</title>
<style>
:root{
  --bg:#faf9fb; --surface:#ffffff; --surface-2:#f4f2f7; --border:#e4e1ea;
  --text:#17151c; --muted:#6b6676; --accent:#6d28d9; --accent-soft:#ede9fe;
  --yes:#b45309; --yes-soft:#fef3c7; --no:#0e7490; --no-soft:#cffafe;
  --shadow:0 1px 2px rgba(23,21,28,.06), 0 8px 24px -16px rgba(23,21,28,.25);
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#09090b; --surface:#141317; --surface-2:#1c1a21; --border:#2b2833;
    --text:#ededf0; --muted:#9b96a6; --accent:#a78bfa; --accent-soft:#2a2140;
    --yes:#fbbf24; --yes-soft:#3a2d10; --no:#22d3ee; --no-soft:#0d2f36;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px -16px rgba(0,0,0,.8);
  }
}
:root[data-theme="dark"]{
  --bg:#09090b; --surface:#141317; --surface-2:#1c1a21; --border:#2b2833;
  --text:#ededf0; --muted:#9b96a6; --accent:#a78bfa; --accent-soft:#2a2140;
  --yes:#fbbf24; --yes-soft:#3a2d10; --no:#22d3ee; --no-soft:#0d2f36;
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px -16px rgba(0,0,0,.8);
}

*{box-sizing:border-box}
body{
  margin:0; background:var(--bg); color:var(--text);
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:16px; line-height:1.55; -webkit-font-smoothing:antialiased;
}
.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
.wrap{max-width:720px; margin:0 auto; padding:40px 20px 96px; display:flex; flex-direction:column; gap:28px}
a{color:inherit}

.masthead{display:flex; flex-direction:column; gap:10px}
.eyebrow{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent);
}
h1{margin:0; font-size:30px; line-height:1.15; letter-spacing:-.022em; text-wrap:balance}
.standfirst{margin:0; color:var(--muted); max-width:62ch}

.stats{
  display:grid; grid-template-columns:repeat(auto-fit,minmax(102px,1fr)); gap:1px;
  background:var(--border); border:1px solid var(--border); border-radius:12px; overflow:hidden;
}
.stat{background:var(--surface); padding:12px 14px; display:flex; flex-direction:column; gap:2px}
.stat-n{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  font-size:20px; font-variant-numeric:tabular-nums; letter-spacing:-.02em;
}
.stat-l{font-size:11px; color:var(--muted); letter-spacing:.04em}

.note{
  background:var(--accent-soft); border:1px solid var(--border); border-left:3px solid var(--accent);
  border-radius:0 10px 10px 0; padding:14px 16px; font-size:14.5px;
}
.note p{margin:0 0 8px} .note p:last-child{margin:0}
.note strong{color:var(--text)}

.feed{display:flex; flex-direction:column; gap:16px; list-style:none; margin:0; padding:0}
.card{
  background:var(--surface); border:1px solid var(--border); border-radius:14px;
  padding:18px 20px 16px; box-shadow:var(--shadow); display:flex; flex-direction:column; gap:12px;
}
.card-head{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.rank{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  font-size:11px; color:var(--muted); font-variant-numeric:tabular-nums;
}
.meta{display:flex; gap:6px; flex-wrap:wrap; flex:1}
.tag{
  font-size:10.5px; letter-spacing:.05em; text-transform:uppercase;
  padding:3px 8px; border-radius:999px; background:var(--surface-2); color:var(--muted);
  border:1px solid var(--border); white-space:nowrap;
}
.tag--quiet{opacity:.75}
.tag--hot{background:var(--accent-soft); color:var(--accent); border-color:transparent; font-weight:600}
.score{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  font-size:13px; font-variant-numeric:tabular-nums; color:var(--muted);
}

.question{margin:0; font-size:21px; line-height:1.25; letter-spacing:-.018em; font-weight:650; text-wrap:balance}
.reason{margin:0; color:var(--muted); font-size:14.5px; max-width:62ch}
.ai-tag{
  font-size:10px; letter-spacing:.06em; text-transform:uppercase; font-weight:700;
  color:var(--accent); border:1px dashed var(--accent); border-radius:4px;
  padding:1px 5px; margin-right:6px; white-space:nowrap;
}

.split{display:flex; height:7px; border-radius:999px; overflow:hidden; gap:2px; margin-top:2px}
.split-yes{background:var(--yes)} .split-no{background:var(--no)}
.split-caption{margin:0; font-size:12px; color:var(--muted); font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace}
.k-yes{color:var(--yes); font-weight:600} .k-no{color:var(--no); font-weight:600}

.evidence{border-top:1px solid var(--border); padding-top:10px}
.evidence summary{cursor:pointer; font-size:12.5px; color:var(--muted); list-style:none; font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace}
.evidence summary::-webkit-details-marker{display:none}
.evidence summary::before{content:"▸ "; color:var(--accent)}
.evidence[open] summary::before{content:"▾ "}
.evidence summary:focus-visible{outline:2px solid var(--accent); outline-offset:3px; border-radius:4px}

.casts{list-style:none; margin:12px 0 0; padding:0; display:flex; flex-direction:column; gap:10px}
.cast{background:var(--surface-2); border-radius:10px; padding:10px 12px; border-left:3px solid var(--border)}
.cast--yes{border-left-color:var(--yes)} .cast--no{border-left-color:var(--no)}
.handle{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace; font-size:13px; color:var(--text); font-weight:600}
.muted{font-size:11.5px; color:var(--muted)}
.dot{color:var(--border); margin:0 2px}
.src{font-size:11.5px; color:var(--accent); text-decoration:none}
.src:hover{text-decoration:underline}
.stance{font-size:10px; letter-spacing:.07em; text-transform:uppercase; font-weight:700; padding:2px 6px; border-radius:4px}
.stance--yes{background:var(--yes-soft); color:var(--yes)}
.stance--no{background:var(--no-soft); color:var(--no)}
.via{font-size:10px; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); border:1px solid var(--border); border-radius:4px; padding:1px 5px}
.via--root{border-style:dashed}
.cast-text{margin:0; font-size:14px; white-space:pre-wrap; overflow-wrap:anywhere}

/* ── cast-first specifics ─────────────────────────────── */
.card--cast{gap:10px}
.cast-top{display:flex; align-items:flex-start; justify-content:space-between; gap:12px}
.said{
  margin:2px 0 0; font-size:19px; line-height:1.4; letter-spacing:-.011em;
  white-space:pre-wrap; overflow-wrap:anywhere; text-wrap:pretty;
  border-left:3px solid var(--accent); padding-left:14px;
}
.engagement{margin:0; font-size:11.5px; color:var(--muted); font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace}
.identified{background:var(--surface-2); border:1px solid var(--border); border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:4px}
.identified-label{margin:0; font-size:10px; letter-spacing:.1em; text-transform:uppercase; color:var(--accent); font-weight:700}
.identified-q{margin:0; font-size:15px; font-weight:600; line-height:1.3; text-wrap:balance}
.identified-meta{margin:0; font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; flex-wrap:wrap}
.rebuttal{background:var(--no-soft); border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:5px}
.rebuttal-label{margin:0; font-size:10px; letter-spacing:.08em; text-transform:uppercase; font-weight:700; color:var(--no)}

.actions{display:flex; gap:8px; flex-wrap:wrap; padding-top:2px}
.btn{
  font:inherit; font-size:13px; font-weight:600; cursor:pointer;
  padding:7px 14px; border-radius:8px; border:1px solid var(--border);
  background:var(--surface-2); color:var(--text);
  transition:transform .08s ease, border-color .15s ease;
  display:inline-flex; align-items:center; gap:7px;
}
.btn:hover{transform:translateY(-1px)}
.btn:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.btn--yes{border-color:var(--yes); color:var(--yes)}
.btn--no{border-color:var(--no); color:var(--no)}
.btn--ghost{margin-left:auto; color:var(--muted)}
.btn--back{border-color:var(--accent); color:var(--accent)}
.btn--challenge{border-color:var(--border)}
.btn-sub{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  font-size:10px; text-transform:uppercase; letter-spacing:.06em;
  color:var(--muted); border-left:1px solid var(--border); padding-left:7px;
}
@media (prefers-reduced-motion:reduce){ .btn{transition:none} .btn:hover{transform:none} }

footer{color:var(--muted); font-size:12.5px; border-top:1px solid var(--border); padding-top:16px}
footer code{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace; font-size:12px}
</style>

<div class="wrap">
  <header class="masthead">
    <span class="eyebrow">Takes · feed experiment · version ${isCast ? "B — cast-first" : "A — question-first"}</span>
    <h1>${heading}</h1>
    <p class="standfirst">${standfirst}</p>
  </header>

  <section class="stats" aria-label="Run statistics">
    <div class="stat"><span class="stat-n mono">${r.total_casts}</span><span class="stat-l">casts in</span></div>
    <div class="stat"><span class="stat-n mono">${r.opinion_casts}</span><span class="stat-l">opinions</span></div>
    <div class="stat"><span class="stat-n mono">${r.rejected_casts}</span><span class="stat-l">rejected</span></div>
    ${r.resolvable_claims_dropped !== undefined ? `<div class="stat"><span class="stat-n mono">${r.resolvable_claims_dropped}</span><span class="stat-l">predictions cut</span></div>` : ""}
    <div class="stat"><span class="stat-n mono">${r.total_clusters}</span><span class="stat-l">questions</span></div>
    <div class="stat"><span class="stat-n mono">${r.both_sides_clusters}</span><span class="stat-l">contested</span></div>
  </section>

  <div class="note">
    <p><strong>What to look for.</strong> Not "is this impressive" — <em>is there a specific person here you'd want to back or argue with?</em> Name the ones you'd actually tap.</p>
    <p>Nothing is staked and no money moves. Buttons are inert. <span class="ai-tag">AI hypothesis</span> marks a counterargument the model invented; a <strong>Someone already disagrees</strong> block is a real cast from a real person.</p>
  </div>

  <main class="feed">
${cards}
  </main>

  <footer>
    Top ${r.feed.length} of ${r.total_clusters} questions from ${r.total_casts} casts ·
    ${r.threads ? `${r.threads} threads · ` : ""}
    sources <code>${r.sources.map((s) => esc(s)).join(", ")}</code> ·
    generated ${esc(new Date(r.generated_at).toLocaleString("en-US"))}
  </footer>
</div>`;
}

function main() {
  const args = process.argv.slice(2);
  let out = "takes-feed.html";
  let layout: Layout = "cast";
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else if (args[i] === "--layout") layout = args[++i] as Layout;
    else paths.push(args[i]);
  }
  if (paths.length !== 1 || (layout !== "cast" && layout !== "question")) {
    console.error(
      "Usage: pnpm render-feed [--layout cast|question] [--out file.html] <report.json>",
    );
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(paths[0], "utf8")) as Report;
  writeFileSync(out, render(report, layout));
  console.error(`[render-feed] ${layout}-first, ${report.feed.length} cards -> ${out}`);
}

main();
