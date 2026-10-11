#!/usr/bin/env tsx
// Dumps a raw Neynar response so we can see the live shape when it differs
// from the docs. The feed/trending parameter list in particular is thinly
// documented; this is how we find out what it actually wants.
//
// Usage:
//   pnpm probe-neynar                    # trending, 24h
//   pnpm probe-neynar --channel base
//   pnpm probe-neynar --window 6h

import "dotenv/config";
import { probeNeynar } from "../lib/neynar.js";

async function main() {
  const args = process.argv.slice(2);
  let channel = "farcaster";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--channel") channel = args[++i];
  }

  const apiKey = process.env.NEYNAR_API_KEY;
  if (!apiKey) {
    console.error("NEYNAR_API_KEY is not set. Add it to .env.");
    process.exit(1);
  }

  console.error(`[probe] channel=${channel}`);
  const raw = (await probeNeynar(apiKey, channel)) as { casts?: unknown[] };
  console.log(JSON.stringify(raw, null, 2).slice(0, 6000));
  console.error(`\n[probe] casts returned: ${raw?.casts?.length ?? "(no .casts key)"}`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
