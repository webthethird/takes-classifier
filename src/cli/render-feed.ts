#!/usr/bin/env tsx
// Renders a feed_<timestamp>.json report into a standalone HTML page.
//
// Kept separate from feed.ts so re-running with fresh casts regenerates the
// page without touching markup: `pnpm feed <corpus>` then `pnpm render-feed
// <report.json>`.
//
// Usage:
//   pnpm render-feed feed_1791750644760.json
//   pnpm render-feed --out /tmp/takes-feed.html feed_*.json

import { readFileSync, writeFileSync } from "node:fs";

type Member = {
  cast: {
    id: string;
    text: string;
    username?: string;
    ts?: string;
    channel?: string | null;
    url?: string;
  };
  stance: "yes" | "no";
  challengeability: number;
  confidence: number;
  challenge_reason: string;
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
  feed: Cluster[];
};

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function relTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function card(c: Cluster, rank: number): string {
  const yes = c.members.filter((m) => m.stance === "yes").length;
  const no = c.members.filter((m) => m.stance === "no").length;
  const total = yes + no;
  const yesPct = total ? Math.round((yes / total) * 100) : 0;

  const splitBar = c.both_sides
    ? `<div class="split" role="img" aria-label="${yes} on yes, ${no} on no">
         <span class="split-yes" style="flex:${yes}"></span>
         <span class="split-no" style="flex:${no}"></span>
       </div>
       <p class="split-caption"><span class="k-yes">${yes} yes</span> · <span class="k-no">${no} no</span> · already contested</p>`
    : "";

  const casts = c.members
    .map(
      (m) => `<li class="cast cast--${m.stance}">
        <div class="cast-head">
          <span class="handle">@${esc(m.cast.username ?? "unknown")}</span>
          <span class="stance stance--${m.stance}">${m.stance}</span>
          ${m.cast.channel ? `<span class="chan">/${esc(m.cast.channel)}</span>` : ""}
          <span class="when">${esc(relTime(m.cast.ts))}</span>
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
    <p class="reason">${esc(c.challenge_reason)}</p>

    ${splitBar}

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

function render(r: Report): string {
  const kept = r.feed.length;
  return `<title>Takes — worth challenging</title>
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

/* ── header ─────────────────────────────────────────── */
.masthead{display:flex; flex-direction:column; gap:10px}
.eyebrow{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent);
}
h1{margin:0; font-size:30px; line-height:1.15; letter-spacing:-.022em; text-wrap:balance}
.standfirst{margin:0; color:var(--muted); max-width:60ch}

.stats{
  display:grid; grid-template-columns:repeat(auto-fit,minmax(104px,1fr)); gap:1px;
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

/* ── cards ──────────────────────────────────────────── */
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

.question{
  margin:0; font-size:21px; line-height:1.25; letter-spacing:-.018em;
  font-weight:650; text-wrap:balance;
}
.reason{margin:0; color:var(--muted); font-size:14.5px; max-width:62ch}

/* the thesis: observed disagreement is the loudest thing on the card */
.split{display:flex; height:7px; border-radius:999px; overflow:hidden; gap:2px; margin-top:2px}
.split-yes{background:var(--yes)} .split-no{background:var(--no)}
.split-caption{
  margin:0; font-size:12px; color:var(--muted);
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
}
.k-yes{color:var(--yes); font-weight:600} .k-no{color:var(--no); font-weight:600}

.evidence{border-top:1px solid var(--border); padding-top:10px}
.evidence summary{
  cursor:pointer; font-size:12.5px; color:var(--muted); list-style:none;
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
}
.evidence summary::-webkit-details-marker{display:none}
.evidence summary::before{content:"▸ "; color:var(--accent)}
.evidence[open] summary::before{content:"▾ "}
.evidence summary:focus-visible{outline:2px solid var(--accent); outline-offset:3px; border-radius:4px}

.casts{list-style:none; margin:12px 0 0; padding:0; display:flex; flex-direction:column; gap:10px}
.cast{background:var(--surface-2); border-radius:10px; padding:10px 12px; border-left:3px solid var(--border)}
.cast--yes{border-left-color:var(--yes)} .cast--no{border-left-color:var(--no)}
.cast-head{display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:5px}
.handle{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  font-size:12.5px; color:var(--text); font-weight:600;
}
.stance{
  font-size:10px; letter-spacing:.07em; text-transform:uppercase; font-weight:700;
  padding:2px 6px; border-radius:4px;
}
.stance--yes{background:var(--yes-soft); color:var(--yes)}
.stance--no{background:var(--no-soft); color:var(--no)}
.chan,.when{font-size:11.5px; color:var(--muted)}
.cast-text{margin:0; font-size:14px; white-space:pre-wrap; overflow-wrap:anywhere}

.actions{display:flex; gap:8px; flex-wrap:wrap; padding-top:2px}
.btn{
  font:inherit; font-size:13px; font-weight:600; cursor:pointer;
  padding:7px 14px; border-radius:8px; border:1px solid var(--border);
  background:var(--surface-2); color:var(--text); transition:transform .08s ease, border-color .15s ease;
}
.btn:hover{transform:translateY(-1px)}
.btn:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.btn--yes{border-color:var(--yes); color:var(--yes)}
.btn--no{border-color:var(--no); color:var(--no)}
.btn--ghost{margin-left:auto; color:var(--muted)}
@media (prefers-reduced-motion:reduce){ .btn{transition:none} .btn:hover{transform:none} }

footer{color:var(--muted); font-size:12.5px; border-top:1px solid var(--border); padding-top:16px}
footer code{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace; font-size:12px}
</style>

<div class="wrap">
  <header class="masthead">
    <span class="eyebrow">Takes · feed experiment</span>
    <h1>Opinions worth challenging</h1>
    <p class="standfirst">Real Farcaster casts, classified into canonical yes/no questions, clustered so the same argument appears once, and ranked by how much they invite someone to take the other side. No staking — this is testing one thing only.</p>
  </header>

  <section class="stats" aria-label="Run statistics">
    <div class="stat"><span class="stat-n mono">${r.total_casts}</span><span class="stat-l">casts in</span></div>
    <div class="stat"><span class="stat-n mono">${r.opinion_casts}</span><span class="stat-l">opinions</span></div>
    <div class="stat"><span class="stat-n mono">${r.rejected_casts}</span><span class="stat-l">rejected</span></div>
    <div class="stat"><span class="stat-n mono">${r.total_clusters}</span><span class="stat-l">questions</span></div>
    <div class="stat"><span class="stat-n mono">${r.both_sides_clusters}</span><span class="stat-l">contested</span></div>
  </section>

  <div class="note">
    <p><strong>What to look for.</strong> Scrolling this, do you want to argue with any of them? Not "is this impressive" — would you tap <em>Challenge</em>?</p>
    <p>Cards marked <strong>contested</strong> already have people on both sides in the source data. Those are the ones that should feel most alive; if they don't, the ranking is wrong, not the idea.</p>
  </div>

  <main class="feed">
${r.feed.map((c, i) => card(c, i + 1)).join("\n")}
  </main>

  <footer>
    Top ${kept} of ${r.total_clusters} questions from ${r.total_casts} casts ·
    sources <code>${r.sources.map((s) => esc(s)).join(", ")}</code> ·
    generated ${esc(new Date(r.generated_at).toLocaleString("en-US"))}
  </footer>
</div>`;
}

function main() {
  const args = process.argv.slice(2);
  let out = "takes-feed.html";
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else paths.push(args[i]);
  }
  if (paths.length !== 1) {
    console.error("Usage: pnpm render-feed [--out file.html] <report.json>");
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(paths[0], "utf8")) as Report;
  writeFileSync(out, render(report));
  console.error(`[render-feed] ${report.feed.length} cards -> ${out}`);
}

main();
