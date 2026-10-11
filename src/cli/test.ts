#!/usr/bin/env tsx
// Assertions for the scoring/identity logic. No framework — this exists
// because bothSidesOf has a genuinely subtle edge case that shipped wrong
// once, and "it looked right" is not good enough for the metric the whole
// experiment is judged on.
//
//   pnpm test

import {
  authorCounts,
  bothSidesOf,
  identity,
  pickOpposingReply,
  pickRepresentative,
  scoreCluster,
  type Member,
} from "../lib/score.js";
import type { RawCast } from "../lib/corpus.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean) {
  if (cond) passed++;
  else failures.push(name);
}

function eq<T>(name: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let n = 0;
function cast(opts: Partial<RawCast> & { fid?: number }): RawCast {
  n++;
  return { id: `0x${n}`, text: `cast ${n}`, ...opts };
}

function member(
  stance: "yes" | "no",
  c: RawCast,
  extra: Partial<Member> = {},
): Member {
  return {
    cast: c,
    stance,
    similarity: 1,
    challengeability: 0.8,
    confidence: 0.9,
    challenge_reason: "r",
    via: "claim",
    ...extra,
  };
}

/* ───────────────────────────── identity ────────────────────────────── */

eq("identity prefers fid", identity(cast({ fid: 7, username: "a" })), "fid:7");
eq("identity falls back to username", identity(cast({ username: "a" })), "u:a");
check(
  "identity falls back to cast id",
  identity({ id: "0xabc", text: "t" }).startsWith("cast:"),
);
check(
  "two unidentified casts are not the same person",
  identity({ id: "0xa", text: "t" }) !== identity({ id: "0xb", text: "t" }),
);
check(
  "same fid, renamed account, is one person",
  identity(cast({ fid: 7, username: "old" })) ===
    identity(cast({ fid: 7, username: "new" })),
);

/* ──────────────────────────── bothSidesOf ──────────────────────────── */

const alice = cast({ fid: 1, username: "alice" });
const bob = cast({ fid: 2, username: "bob" });

check("two independent opposing authors", bothSidesOf([
  member("yes", alice),
  member("no", bob),
]));

check("self-reply on both sides is NOT contested", !bothSidesOf([
  member("yes", cast({ fid: 3 })),
  member("no", cast({ fid: 3 })),
]));

// The regression this module exists for. Alice(yes) and Bob(no) are different
// people, so this IS contested — an exclusivity test wrongly returned false
// because Bob also appears on the yes side.
check("mixed-stance author does not mask real disagreement", bothSidesOf([
  member("yes", cast({ fid: 1 })),
  member("yes", cast({ fid: 2 })),
  member("no", cast({ fid: 2 })),
]));

check("one-sided cluster is not contested", !bothSidesOf([
  member("yes", alice),
  member("yes", bob),
]));
check("empty cluster is not contested", !bothSidesOf([]));
check(
  "single member is not contested",
  !bothSidesOf([member("yes", alice)]),
);

/* ──────────────────────────── authorCounts ─────────────────────────── */

const counts = authorCounts([
  member("yes", cast({ fid: 1 })),
  member("yes", cast({ fid: 1 })), // same person, twice
  member("yes", cast({ fid: 2 })),
  member("no", cast({ fid: 3 })),
]);
eq("yes casts counted per message", counts.yes_casts, 3);
eq("yes authors deduped by person", counts.yes_authors, 2);
eq("no authors", counts.no_authors, 1);
eq("distinct authors overall", counts.distinct_authors, 3);

/* ───────────────────────────── scoring ─────────────────────────────── */

const uncontestedStrong = scoreCluster([
  member("yes", alice, { challengeability: 0.95, confidence: 1 }),
]);
const contestedWeak = scoreCluster([
  member("yes", alice, { challengeability: 0.5, confidence: 1 }),
  member("no", bob, { challengeability: 0.5, confidence: 1 }),
]);
check(
  "a strong unchallenged take outranks a weak contested one",
  uncontestedStrong.score > contestedWeak.score,
);
check("contested flag set", contestedWeak.bothSides);
check("uncontested flag clear", !uncontestedStrong.bothSides);

const lowConfidence = scoreCluster([
  member("yes", alice, { challengeability: 0.95, confidence: 0.1 }),
]);
check(
  "low confidence dampens but does not zero the score",
  lowConfidence.score < uncontestedStrong.score && lowConfidence.score > 0,
);

/* ──────────────────────── representative pick ──────────────────────── */

const root = cast({ fid: 1, username: "root" });
const reply = cast({ fid: 2, username: "replier" });
const rep = pickRepresentative([
  member("no", reply, { via: "stance", challengeability: 0.99 }),
  member("yes", root, { via: "claim", challengeability: 0.4 }),
]);
eq(
  "representative prefers the cast the question came from",
  rep.cast.username,
  "root",
);

const a = cast({ fid: 1, username: "a", replies: 1 });
const b = cast({ fid: 2, username: "b", replies: 50 });
eq(
  "engagement breaks challengeability ties",
  pickRepresentative([
    member("yes", a, { challengeability: 0.8 }),
    member("yes", b, { challengeability: 0.8 }),
  ]).cast.username,
  "b",
);

const d1 = cast({ fid: 1, username: "z" });
const d2 = cast({ fid: 2, username: "y" });
eq(
  "selection is deterministic across orderings",
  pickRepresentative([member("yes", d1), member("yes", d2)]).cast.id,
  pickRepresentative([member("yes", d2), member("yes", d1)]).cast.id,
);

/* ───────────────────────── opposing reply ──────────────────────────── */

const repMember = member("yes", alice);
eq(
  "opposing reply is someone else on the other side",
  pickOpposingReply([repMember, member("no", bob)], repMember)?.cast.username,
  "bob",
);
eq(
  "author disagreeing with themselves is not an opposing reply",
  pickOpposingReply(
    [repMember, member("no", cast({ fid: 1, username: "alice" }))],
    repMember,
  ),
  null,
);
eq(
  "no opposition returns null",
  pickOpposingReply([repMember, member("yes", bob)], repMember),
  null,
);

/* ───────────────────────────── results ─────────────────────────────── */

if (failures.length) {
  console.error(`\n${failures.length} FAILED:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`${passed} passed`);
