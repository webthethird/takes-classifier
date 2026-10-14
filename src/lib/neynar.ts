// Live Farcaster casts via Neynar.
//
// Strategy, driven by the first run over the static corpora: 348 keyword-
// searched casts produced 93 distinct questions and only ONE with people on
// both sides. Isolated casts don't argue with each other — disagreement lives
// in reply threads. So this source does NOT return a flat list of casts. It:
//
//   1. pulls candidate casts from a feed
//   2. drops anything without enough replies to contain an argument
//      (this is also the cost control — the expensive step is classification,
//      and engagement is a free pre-filter)
//   3. fetches each survivor's conversation and flattens root + replies,
//      setting `parent_text` so replies classify as stances on the parent
//      rather than as context-free noise
//
// API shape verified against the live API (Oct 2026), not just the docs:
//   GET /v2/farcaster/feed/              feed_type, filter_type, channel_id, limit<=100
//   GET /v2/farcaster/cast/conversation/ identifier, type, reply_depth<=5, limit<=50
//   auth header: x-api-key
//
// There is NO trending *cast* feed, despite a docs page for one. Confirmed
// against Neynar's own OpenAPI spec: the only /v2/farcaster/feed/* paths are
// `/`, `/channels/`, `/following/`, `/parent_urls/`, `/topic/`, `/user/casts/`,
// `/user/popular/`, `/user/replies_and_recasts/`. The "Fetch trending feed"
// reference page documents an SDK method with no REST section — an orphaned
// route. Trending endpoints do exist for channels, topics and fungibles.
//
// So scope comes from two places instead:
//   - `/channel/trending/` (time_window: 1d|7d|30d) discovers active channels
//     dynamically, rather than us hardcoding a list
//   - `/feed/channels/` takes up to 10 channel ids in ONE call
// `/topic/trending/` returns an empty list at time of writing; revisit.
// Confirmed by Neynar directly (Oct 2026): "trending casts was removed from
// the live api surface rn; this smells like stale docs/sdk, not a plan gate...
// for trending casts specifically, you'll likely need to rank them yourself
// from another feed/search path."
//
// That search path is `/cast/search/` with `mode=semantic`, which is network-
// wide rather than channel-bound and returns much better-shaped candidates
// than any channel feed. Note its response nests under `result.casts`, unlike
// the feed endpoints' top-level `casts`.

import type { CastSource, RawCast } from "./corpus.js";

const BASE = "https://api.neynar.com/v2/farcaster";

/* ───────────────────── Response shapes (partial) ───────────────────── */
// Deliberately loose: we read a handful of fields and ignore the rest, so an
// additive API change can't break us. Missing REQUIRED fields throw loudly.

type NeynarUser = { username?: string; fid?: number };
type NeynarCast = {
  hash: string;
  text: string;
  timestamp?: string;
  author?: NeynarUser;
  parent_hash?: string | null;
  thread_hash?: string | null;
  channel?: { id?: string } | null;
  reactions?: { likes_count?: number; recasts_count?: number };
  replies?: { count?: number };
  direct_replies?: NeynarCast[];
};

export type NeynarFeedSpec = { kind: "channel"; channelIds: string[] };

export type NeynarOptions = {
  apiKey: string;
  feed: NeynarFeedSpec;
  /// Candidate casts to pull PER CHANNEL before filtering. Neynar caps the
  /// feed limit at 100. Worth pulling near the cap: in a sample of 25 casts
  /// from /farcaster, only 5 had 2+ replies.
  candidates?: number;
  /// Minimum reply count for a cast to be worth fetching a thread for. The
  /// single most important cost lever: it decides how many conversations we
  /// fetch and how many casts reach the classifier.
  minReplies?: number;
  /// How deep to walk replies. 1 = direct replies only, which is where most
  /// disagreement is. Deeper gets sub-arguments and more noise.
  replyDepth?: number;
  /// Max threads to expand per run.
  maxThreads?: number;
  /// Politeness delay between conversation fetches (ms).
  delayMs?: number;
  /// Minimum characters for a cast to be considered substantive. See the
  /// pre-filter notes above — this is what stops greeting chains from eating
  /// the classifier budget.
  minChars?: number;
  /// Discover channels from /channel/trending/ instead of (or in addition to)
  /// the explicit list.
  trendingChannels?: { window: "1d" | "7d" | "30d"; limit: number };
  /// Semantic search queries run against /cast/search/. Network-wide, so this
  /// is how we escape channel scope. Results are merged with channel
  /// candidates and deduped by hash.
  searches?: string[];
  /// How many substantive casts to take REGARDLESS of reply count. This is
  /// the unchallenged-hot-take lane: a sharp opinion nobody has answered yet
  /// is the thing the feed exists to surface, and filtering candidates on
  /// reply count excludes every one of them. These are never expanded into
  /// threads — there is nothing to expand — so they cost one stage-1 call
  /// each and no conversation fetch.
  unchallenged?: number;
  /// Drop candidates older than this many days. The dedicated opinion
  /// channels are low-volume — 100 casts from /hottakes spans eight months —
  /// and deep pagination also skews old, since older casts have had longer to
  /// accumulate the replies the engagement filter selects on. A card about a
  /// news cycle from last February is worse than no card.
  maxAgeDays?: number;
  /// Pages to walk per channel batch. /feed/channels/ returns `limit` casts
  /// TOTAL across the batch (max 100), not per channel, so depth comes from
  /// paginating rather than from adding channels.
  pages?: number;
};

/* ────────────────────────── HTTP plumbing ──────────────────────────── */

async function neynarGet<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const url = `${BASE}${path}?${qs}`;
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey, accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Neynar ${res.status} ${res.statusText} for ${path} — ${body.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────── Search queries ────────────────────────────── */
//
// Search is the primary source, not channels. Measured over 17 queries:
// 1,382 distinct casts, of which **75% are in no channel at all**. Channel
// feeds were therefore missing the large majority of Farcaster — and since
// there is no trending-cast endpoint, semantic search is the only way to
// reach those casts.
//
// Two measured properties shape this list:
//   - Queries are near-disjoint. Each of these contributes ~99-100 casts the
//     others didn't, so adding queries adds reach almost linearly.
//   - Short, natural, cast-like phrasings win. "controversial opinion"
//     returns 100; "unpopular opinion that people disagree with" returns 15.
//     Write them the way a person would actually type, not as a description
//     of what you want.
//
// `mode=hybrid` is deliberately unused: it returned byte-identical sets to
// `semantic` on every query tried, so it only doubles the request count.
export const OPINION_QUERIES = [
  "controversial opinion",
  "hot take",
  "change my mind",
  "this is overrated and here is why",
  "everyone is wrong about this",
  "most people are wrong about",
  "I will die on this hill",
  "actually I think the opposite",
  "I don't think that's right at all",
  "honestly this is a mistake",
  "this is a bad idea and here's why",
  "this take will be unpopular but",
  "nobody wants to admit this",
  "the real problem nobody talks about",
  "people are sleeping on this",
] as const;

/// Channels that exist specifically for contested opinions. Small, but the
/// hit rate is far better than a general-interest channel, so they're always
/// included alongside search rather than being something you remember to ask
/// for. Follower counts at time of writing: hottakes 2.5k, debate 314,
/// hot-takes 129, unpopularopinion 103.
export const OPINION_CHANNELS = [
  "hottakes",
  "debate",
  "hot-takes",
  "unpopularopinion",
] as const;

/* ───────────────────── Substance pre-filter ────────────────────────── */
//
// The single most important lesson from the first live run: filtering
// candidates on REPLY COUNT selects for greeting chains, not arguments. The
// highest-reply casts in /base and /farcaster are "Base Morning" posts with
// dozens of "bm fam" replies. 444 casts pulled that way yielded 2 opinions —
// 442 wasted classifier calls, median reply length 22 characters.
//
// So substance is checked locally, for free, before we spend anything. This
// runs before the conversation fetch AND before classification.

/// Greeting/ritual patterns that dominate high-reply Farcaster threads.
const RITUAL = new RegExp(
  [
    "^(g\\s*m|b\\s*m|g\\s*n|wagmi|lfg|lets? go|based)\\b",
    "\\b(base|good|happy)\\s+(morning|night|evening|monday|friday)\\b",
    "^(thanks?|ty|congrats|welcome|nice|cool|agreed|same|this|fr|facts)\\b",
    "^\\W*$", // emoji / punctuation only
  ].join("|"),
  "i",
);

/// Minimum characters for a cast to plausibly contain an arguable claim.
/// Tuned off the first live run, where p75 of rejected casts was 25 chars.
const MIN_SUBSTANTIVE_CHARS = 40;

export function looksSubstantive(text: string, minChars = MIN_SUBSTANTIVE_CHARS): boolean {
  const t = text.trim();
  if (t.length < minChars) return false;
  if (RITUAL.test(t)) return false;
  // Mostly-mentions or mostly-links carry no claim of their own.
  const stripped = t.replace(/https?:\/\/\S+/g, "").replace(/@\w+/g, "").trim();
  return stripped.length >= minChars;
}

/* ────────────────────────── Normalisation ──────────────────────────── */

function toRawCast(c: NeynarCast, parentText?: string): RawCast {
  return {
    id: c.hash,
    text: (c.text ?? "").trim(),
    ts: c.timestamp,
    username: c.author?.username,
    fid: c.author?.fid,
    channel: c.channel?.id ?? null,
    parent_hash: c.parent_hash ?? null,
    parent_text: parentText,
    thread_root_hash: c.thread_hash ?? c.hash,
    url: c.author?.username
      ? `https://farcaster.xyz/${c.author.username}/${c.hash.slice(0, 10)}`
      : undefined,
    replies: c.replies?.count,
    recasts: c.reactions?.recasts_count,
    likes: c.reactions?.likes_count,
  };
}

/// Walks the recursive direct_replies tree, attaching each reply's parent text.
/// Depth-limited by what the API returned, so reply_depth controls the size.
function flattenThread(root: NeynarCast): RawCast[] {
  const out: RawCast[] = [toRawCast(root)];
  const walk = (node: NeynarCast) => {
    for (const child of node.direct_replies ?? []) {
      if (child.text?.trim()) out.push(toRawCast(child, node.text));
      walk(child);
    }
  };
  walk(root);
  return out;
}

/* ──────────────────────────── The source ───────────────────────────── */

export function neynarSource(opts: NeynarOptions): CastSource {
  const {
    apiKey,
    feed,
    candidates = 50,
    minReplies = 2,
    replyDepth = 1,
    maxThreads = 15,
    delayMs = 250,
    minChars,
    trendingChannels,
    searches = [],
    maxAgeDays,
    pages = 1,
    unchallenged = 0,
  } = opts;

  const label =
    [feed.channelIds.join("+"), searches.length ? `search(${searches.length})` : ""]
      .filter(Boolean)
      .join("+") || "neynar";

  return {
    name: label,
    async load(limit = Infinity) {
      // 1. Resolve the channel set. Trending discovery widens scope beyond
      //    whatever we thought to hardcode.
      const channelIds = [...feed.channelIds];
      if (trendingChannels) {
        const t = await neynarGet<{ channels?: Array<{ id?: string; channel?: { id?: string } }> }>(
          "/channel/trending/",
          { limit: trendingChannels.limit, time_window: trendingChannels.window },
          apiKey,
        );
        for (const c of t.channels ?? []) {
          const id = c.channel?.id ?? c.id;
          if (id && !channelIds.includes(id)) channelIds.push(id);
        }
        console.error(`[neynar] trending channels -> ${channelIds.join(", ")}`);
      }
      if (channelIds.length === 0 && searches.length === 0) {
        throw new Error("Nothing to pull from — give --channel or --search");
      }

      // 2. Candidates. /feed/channels/ takes up to 10 ids per call.
      const pulled: NeynarCast[] = [];
      for (let i = 0; i < channelIds.length; i += 10) {
        const batch = channelIds.slice(i, i + 10);
        let cursor: string | undefined;
        let pageCount = 0;
        for (let page = 0; page < pages; page++) {
          const res = await neynarGet<{
            casts?: NeynarCast[];
            next?: { cursor?: string | null };
          }>(
            "/feed/channels/",
            {
              channel_ids: batch.join(","),
              limit: Math.min(candidates, 100),
              with_recasts: "false",
              members_only: "false",
              cursor,
            },
            apiKey,
          );
          const got = res.casts ?? [];
          pulled.push(...got);
          pageCount += got.length;
          cursor = res.next?.cursor ?? undefined;
          await sleep(delayMs);
          if (!cursor || got.length === 0) break;
        }
        console.error(
          `[neynar] ${batch.join(",")}: ${pageCount} candidates over <=${pages} page(s)`,
        );
      }
      // 2b. Semantic search — network-wide, not channel-bound.
      for (const q of searches) {
        // sort_type=desc_chron is the freshness lever. Without it, search
        // ranks by relevance across all time and returns mostly old casts —
        // measured, 84% of results were older than 14 days. With it, the same
        // queries surface their most recent matches instead.
        //
        // `mode` is then irrelevant: literal, semantic and hybrid returned
        // byte-identical result sets once sort_type was set. Left at semantic
        // so the queries can stay natural-language.
        const res = await neynarGet<{ result?: { casts?: NeynarCast[] } }>(
          "/cast/search/",
          {
            q,
            mode: "semantic",
            sort_type: "desc_chron",
            limit: Math.min(candidates, 100),
          },
          apiKey,
        );
        const got = res.result?.casts ?? [];
        console.error(`[neynar] search ${JSON.stringify(q)}: ${got.length} candidates`);
        pulled.push(...got);
        await sleep(delayMs);
      }

      // Age filter, before anything is spent on it.
      if (maxAgeDays !== undefined) {
        const cutoff = Date.now() - maxAgeDays * 86_400_000;
        const before = pulled.length;
        const fresh = pulled.filter((c) => {
          if (!c.timestamp) return true;
          const t = new Date(c.timestamp).getTime();
          return Number.isNaN(t) || t >= cutoff;
        });
        pulled.length = 0;
        pulled.push(...fresh);
        console.error(
          `[neynar] age filter (<=${maxAgeDays}d): ${before} -> ${pulled.length}`,
        );
      }

      // Dedupe — a cast can arrive from both a channel feed and a search.
      const byHash = new Map<string, NeynarCast>();
      for (const c of pulled) if (c.hash) byHash.set(c.hash, c);
      pulled.length = 0;
      pulled.push(...byHash.values());

      if (pulled.length === 0) {
        throw new Error(
          `Neynar returned no casts for ${label}. Check the channel ids — \`pnpm probe-neynar\` dumps a raw response.`,
        );
      }

      // 3. Select threads worth expanding: enough replies to contain an
      //    argument AND a root that actually says something. The substance
      //    check is what separates a contested take from a "Base Morning"
      //    chain, which otherwise wins on reply count every time.
      const enoughReplies = pulled.filter(
        (c) => (c.replies?.count ?? 0) >= minReplies,
      );
      const contested = enoughReplies
        .filter((c) => looksSubstantive(c.text ?? "", minChars))
        .sort((a, b) => (b.replies?.count ?? 0) - (a.replies?.count ?? 0))
        .slice(0, maxThreads);

      console.error(
        `[neynar] ${pulled.length} candidates -> ${enoughReplies.length} with >=${minReplies} replies -> ${contested.length} substantive`,
      );

      // 3b. Unchallenged lane. Substantive casts nobody has replied to (or
      //     that didn't make the thread cut), newest first. Ranking decides
      //     whether they deserve the top of the feed; candidate selection
      //     shouldn't make that call for it.
      const expanding = new Set(contested.map((c) => c.hash));
      const solo =
        unchallenged > 0
          ? pulled
              .filter(
                (c) =>
                  !expanding.has(c.hash) &&
                  looksSubstantive(c.text ?? "", minChars),
              )
              .sort((a, b) =>
                (b.timestamp ?? "").localeCompare(a.timestamp ?? ""),
              )
              .slice(0, unchallenged)
          : [];
      if (unchallenged > 0) {
        const noReplies = solo.filter((c) => (c.replies?.count ?? 0) === 0).length;
        console.error(
          `[neynar] unchallenged lane: ${solo.length} standalone casts (${noReplies} with zero replies)`,
        );
      }

      // 3. Expand each into a thread.
      const out: RawCast[] = [];
      const seen = new Set<string>();
      for (const cand of contested) {
        try {
          const conv = await neynarGet<{
            conversation?: { cast?: NeynarCast };
          }>(
            "/cast/conversation/",
            {
              identifier: cand.hash,
              type: "hash",
              reply_depth: Math.min(Math.max(replyDepth, 0), 5),
              limit: 50,
            },
            apiKey,
          );
          const rootCast = conv.conversation?.cast;
          if (!rootCast) {
            console.error(`[neynar] no conversation body for ${cand.hash}`);
            continue;
          }
          for (const rc of flattenThread(rootCast)) {
            if (seen.has(rc.id)) continue;
            seen.add(rc.id);
            // Keep the thread root regardless (it passed the check above);
            // drop ritual replies so they never reach the classifier.
            if (rc.parent_text && !looksSubstantive(rc.text, minChars)) continue;
            out.push(rc);
          }
        } catch (e) {
          // One bad thread shouldn't kill the run.
          console.error(`[neynar] thread ${cand.hash} failed: ${String(e).slice(0, 160)}`);
        }
        await sleep(delayMs);
      }

      for (const c of solo) {
        if (seen.has(c.hash)) continue;
        seen.add(c.hash);
        out.push(toRawCast(c));
      }

      const withParents = out.filter((c) => c.parent_text).length;
      console.error(
        `[neynar] ${out.length} casts from ${contested.length} threads (${withParents} replies with parent context)`,
      );
      return out.slice(0, limit);
    },
  };
}

/// Dumps a raw response so we can adapt fast when the live shape differs from
/// the docs. Used by `pnpm probe-neynar`.
export async function probeNeynar(
  apiKey: string,
  channelId: string,
): Promise<unknown> {
  return neynarGet(
    "/feed/",
    {
      limit: 3,
      feed_type: "filter",
      filter_type: "channel_id",
      channel_id: channelId,
    },
    apiKey,
  );
}
