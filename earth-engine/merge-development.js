#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function usage() {
  console.error(
    "Usage: node earth-engine/merge-development.js base.json incoming.json [--write output.json]"
  );
}

function main() {
  const args = process.argv.slice(2);
  const [basePath, incomingPath] = args;
  if (!basePath || !incomingPath) {
    usage();
    process.exit(1);
  }

  const wi = args.indexOf("--write");
  const outputPath =
    wi >= 0 && args[wi + 1] && !args[wi + 1].startsWith("--")
      ? path.resolve(args[wi + 1])
      : null;

  const base = readJson(path.resolve(basePath));
  const incoming = readJson(path.resolve(incomingPath));

  const merged = {
    ...base,
    ...incoming,
    generatedAt: new Date().toISOString(),
    areas: {
      ...(base.areas || {}),
      ...(incoming.areas || {}),
    },
  };

  const json = JSON.stringify(merged, null, 2);
  if (outputPath) {
    fs.writeFileSync(outputPath, json, "utf8");
    console.error("Wrote", outputPath);
    return;
  }
  process.stdout.write(json + "\n");
}

main();
