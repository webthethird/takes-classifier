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
  /// Text of the cast this one replies to. This is the field the whole
  /// thread-pull exists for: `classifyCast` takes it as `parentText`, and
  /// without it a reply like "nah, totally disagree" classifies as noise
  /// instead of as a stance on the parent's claim.
  parent_text?: string;
  /// Hash of the thread root, so feed consumers can group a conversation.
  thread_root_hash?: string;
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

