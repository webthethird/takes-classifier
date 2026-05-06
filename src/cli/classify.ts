#!/usr/bin/env tsx
// One-cast CLI: read text from argv (or stdin) and print structured output.
// Usage:
//   pnpm classify "$SNAP airdrop was a joke"
//   echo "$SNAP airdrop was a joke" | pnpm classify
//   pnpm classify --parent "Excited about $SNAP!" "Yeah I sold instantly"

import { classifyCast } from "../lib/classify.js";

async function main() {
  const args = process.argv.slice(2);
  let parentText: string | undefined;
  let castText: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--parent") {
      parentText = args[++i];
    } else {
      castText = args[i];
    }
  }

  if (!castText) {
    castText = await new Promise<string>((resolve, reject) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (buf += c));
      process.stdin.on("end", () => resolve(buf.trim()));
      process.stdin.on("error", reject);
    });
  }

  if (!castText) {
    console.error("Usage: pnpm classify [--parent <parent text>] <cast text>");
    process.exit(1);
  }

  const result = await classifyCast({ text: castText, parentText });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
