#!/usr/bin/env node

// Validate a Connections puzzle before it goes live. The key rule: groups must
// be mutually exclusive — no single item may belong to more than one group, and
// no two items may be identical (which would make a tile ambiguous). Also checks
// the basic 4x4 shape.
//
// Usage:
//   npm run validate:connections -- --puzzle 2026-week-23
//   npm run validate:connections -- --file data/puzzles/2026-week-23.json

import { readFile } from "node:fs/promises";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const file = args.file || `data/puzzles/${args.puzzle || "2026-week-23"}.json`;

const puzzle = JSON.parse(await readFile(file, "utf8"));
const errors = [];
const warnings = [];

if (puzzle.type !== "connections") errors.push(`type is "${puzzle.type}", expected "connections"`);

const categories = puzzle.categories || [];
if (categories.length !== 4) errors.push(`expected 4 groups, found ${categories.length}`);

categories.forEach((category) => {
  if (!category.title) errors.push(`a group is missing a title`);
  if ((category.items || []).length !== 4) {
    errors.push(`group "${category.title}" has ${category.items?.length ?? 0} items, expected 4`);
  }
});

// Mutual exclusivity: each item appears in exactly one group (case-insensitive).
const seen = new Map(); // normalized item -> group title
for (const category of categories) {
  for (const item of category.items || []) {
    const key = String(item).trim().toLowerCase();
    if (seen.has(key)) {
      errors.push(`"${item}" appears in both "${seen.get(key)}" and "${category.title}" — groups must be mutually exclusive`);
    } else {
      seen.set(key, category.title);
    }
  }
}

// Soft check: near-duplicate items that differ only by punctuation/spacing.
const normalizedToOriginal = new Map();
for (const category of categories) {
  for (const item of category.items || []) {
    const loose = String(item).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalizedToOriginal.has(loose) && normalizedToOriginal.get(loose) !== item) {
      warnings.push(`"${item}" looks very similar to "${normalizedToOriginal.get(loose)}" — could be confusing`);
    }
    normalizedToOriginal.set(loose, item);
  }
}

console.log(`Validating ${file}`);
console.log(`Title: ${puzzle.title || "(none)"}`);
categories.forEach((category) => console.log(`  • ${category.title}: ${(category.items || []).join(", ")}`));

warnings.forEach((warning) => console.warn(`  ! ${warning}`));

if (errors.length) {
  console.error(`\nFAILED with ${errors.length} error(s):`);
  errors.forEach((error) => console.error(`  ✗ ${error}`));
  process.exit(1);
}

console.log(`\nValid: 4 groups of 4, all items mutually exclusive.`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
