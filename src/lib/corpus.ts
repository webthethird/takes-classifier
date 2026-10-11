// Cast sources for the feed pipeline.
//
// The pipeline downstream of this file doesn't care where casts come from, so
// swapping the static corpora for a live Farcaster feed is a matter of adding
// a CastSource implementation — nothing in feed.ts changes.
//
// Engagement fields are optional because the static corpora in data/ don't
// carry them. Live sources should populate them: replies and quotes are the
// single best cheap signal for "people already disagree about this", and the
// ranker uses them when present.

import { readFileSync } from "node:fs";
import { basename } from "node:path";

export type RawCast = {
  /// Stable identity. Real cast hash when a source has one, else
  /// `username@ts`, which is good enough to dedupe within a run.
  id: string;
  text: string;
  ts?: string;
  username?: string;
  fid?: number;
  channel?: string | null;
  parent_hash?: string | null;
  /// Permalink, when the source can build one.
  url?: string;
  /// Engagement. Absent on static corpora; populated by live sources.
  replies?: number;
  recasts?: number;
  likes?: number;
};

export interface CastSource {
  name: string;
  load(limit?: number): Promise<RawCast[]>;
}

/// Reads one of the pulled JSON corpora in data/.
export function fileSource(path: string): CastSource {
  return {
    name: basename(path, ".json"),
    async load(limit = Infinity) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Array<
        Omit<RawCast, "id"> & { id?: string }
      >;
      return raw
        .filter((c) => c.text?.trim())
        .slice(0, limit)
        .map((c, i) => ({
          ...c,
          id: c.id ?? `${c.username ?? "unknown"}@${c.ts ?? i}`,
          text: c.text.trim(),
        }));
    },
  };
}

/// Live Farcaster casts. Not implemented yet — this is the slot.
///
/// Implementation notes for when we wire it up:
///   - **Pull threads, not search results.** This is the main finding from the
///     first run over data/: 348 keyword-searched casts produced 93 distinct
///     questions but only ONE with people on both sides. Isolated casts rarely
///     argue with each other — the disagreement lives in reply threads. Fetch a
///     cast *with its replies* and pass the parent via `classifyCast`'s
///     `parentText`, which has been supported all along and which the static
///     corpora can't exercise because they carry no thread context.
///   - Pull from a ranked/trending endpoint, not the firehose. We want casts
///     people already reacted to, not every cast ever written.
///   - Pre-filter on engagement BEFORE classifying. A cast with replies or
///     quote-casts is, by definition, one somebody disagreed with. This is
///     what keeps the Claude bill proportional to signal instead of volume.
///   - Populate `replies` / `recasts` / `likes` so the ranker can use the
///     contestedness boost, and `url` so feed rows link back to the source.
///   - Dedupe across runs by cast hash; the in-run dedupe here isn't enough
///     once this is on a schedule.
export function neynarSource(_opts: {
  apiKey: string;
  feed: "trending" | { channel: string };
  minReplies?: number;
}): CastSource {
  throw new Error(
    "neynarSource not implemented — validate the flow on fileSource first",
  );
}
