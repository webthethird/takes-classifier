// On-disk cache for classification results.
//
// Two reasons this exists:
//   1. Classifying a corpus is the slow, paid step. Tuning the ranking
//      weights in feed.ts shouldn't re-pay for it — only the ranking changed.
//   2. A long run that dies partway through used to lose everything. Now it
//      resumes from wherever it got to.
//
// Keyed by cast text, namespaced by PROMPT_VERSION. Bump PROMPT_VERSION
// whenever the system prompt or output schema changes, otherwise reruns will
// serve stale results that don't match the new shape.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { classifyCast, classifyStance } from "./classify.js";
import { ClassifyResult, StanceResult } from "./schema.js";

/// Bump when the prompt or schema changes. `challengeability` +
/// `challenge_reason` were added in v2.
/// Versioned separately so changing one prompt doesn't discard the other's
/// cached results — they're independent calls with independent schemas.
/// v3 added `externally_resolvable` to Claim.
const CLASSIFY_VERSION = "v4";
const STANCE_VERSION = "v1";
const CACHE_PATH = ".cache/classify.json";
/// Flush every N new entries. Small enough that a kill loses almost nothing,
/// large enough to avoid hammering the disk.
const FLUSH_EVERY = 5;

type Entry = { version: string; result: unknown };
type CacheFile = Record<string, Entry>;

/// Parent text is part of the key: the same reply classifies differently with
/// and without its thread context, which is the entire point of the thread
/// pull. Keying on text alone would serve a context-free result for a cast we
/// later re-classified with its parent.
function keyFor(text: string, parentText?: string): string {
  return createHash("sha256")
    .update(`${parentText ?? ""}\u0000${text}`)
    .digest("hex")
    .slice(0, 32);
}

export class ClassifyCache {
  private data: CacheFile = {};
  private dirty = 0;
  hits = 0;
  misses = 0;

  constructor(private path: string = CACHE_PATH) {
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, "utf8")) as CacheFile;
      } catch {
        // Corrupt cache is not worth failing a run over — start clean.
        this.data = {};
      }
    }
  }

  /// Returns the cached result if present and version-current, else calls the
  /// classifier and stores the result.
  async classify(text: string, parentText?: string): Promise<ClassifyResult> {
    const k = keyFor(text, parentText);
    const hit = this.data[k];
    if (hit && hit.version === CLASSIFY_VERSION) {
      const parsed = ClassifyResult.safeParse(hit.result);
      if (parsed.success) {
        this.hits++;
        return parsed.data;
      }
      // Shape drifted from the schema — treat as a miss and overwrite.
    }

    this.misses++;
    const result = await classifyCast({ text, parentText });
    this.data[k] = { version: CLASSIFY_VERSION, result };
    if (++this.dirty >= FLUSH_EVERY) this.flush();
    return result;
  }

  /// Stage 2, cached on (question, reply) — the root text is implied by the
  /// question and including it would miss cache on trivial root edits.
  async stance(
    question: string,
    rootText: string,
    replyText: string,
  ): Promise<StanceResult> {
    const k = "s:" + keyFor(replyText, question);
    const hit = this.data[k];
    if (hit && hit.version === STANCE_VERSION) {
      const parsed = StanceResult.safeParse(hit.result);
      if (parsed.success) {
        this.hits++;
        return parsed.data;
      }
    }
    this.misses++;
    const result = await classifyStance({ question, rootText, replyText });
    this.data[k] = { version: STANCE_VERSION, result };
    if (++this.dirty >= FLUSH_EVERY) this.flush();
    return result;
  }

  /// Atomic write via temp file + rename, so a kill mid-write can't corrupt
  /// the cache we just spent money filling.
  flush(): void {
    if (this.dirty === 0) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
    this.dirty = 0;
  }

  get size(): number {
    return Object.keys(this.data).length;
  }

  /// Flush on the signals that killed the last run.
  installExitHandlers(): void {
    const save = () => {
      this.flush();
      process.exit(130);
    };
    process.on("SIGINT", save);
    process.on("SIGTERM", save);
    process.on("SIGHUP", save);
    process.on("beforeExit", () => this.flush());
  }
}
