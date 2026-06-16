#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readJsonl } from "./lib/jsonl.mjs";

const monthNumbers = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12
};

const args = parseArgs(process.argv.slice(2));
const input = args.input || "content/processed/text/come-follow-me-old-testament-2026.pages.jsonl";
const output = args.output || "content/processed/cfm/come-follow-me-old-testament-2026-assignments.json";
const sourceFile = args.source || "come-follow-me-old-testament-2026.pdf";

const pages = await readJsonl(input);
const tocRows = parseTableOfContents(pages);
const headingRows = parseBodyHeadings(pages);
const headingByDate = new Map(headingRows.map((row) => [normalizeDateLabel(row.dateLabel), row]));

const assignments = tocRows.map((row, index) => {
  const heading = headingByDate.get(normalizeDateLabel(row.dateLabel));
  const nextHeading = tocRows
    .slice(index + 1)
    .map((next) => headingByDate.get(normalizeDateLabel(next.dateLabel)))
    .find(Boolean);

  const dates = parseDateRange(row.dateLabel);
  return {
    id: `cfm-ot-2026-${dates.startDate}`,
    sourceFile,
    dateLabel: row.dateLabel,
    startDate: dates.startDate,
    endDate: dates.endDate,
    title: heading?.title || "",
    scriptureAssignment: heading?.scriptureAssignment || row.assignment,
    contentsAssignment: row.assignment,
    manualPrintedPageStart: row.printedPage,
    manualPrintedPageEnd: nextHeading?.printedPage ? nextHeading.printedPage - 1 : null,
    manualPdfPageStart: heading?.pdfPageNumber || null,
    manualPdfPageEnd: nextHeading?.pdfPageNumber ? nextHeading.pdfPageNumber - 1 : null
  };
});

await mkdir(path.dirname(output), { recursive: true });
await writeFile(
  output,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sourceFile,
      count: assignments.length,
      assignments
    },
    null,
    2
  )}\n`
);

console.log(`Wrote ${assignments.length} Come Follow Me assignments to ${output}`);

function parseTableOfContents(pageRows) {
  const rows = [];
  const dateLine = /^([A-Z][a-z]+ \d{1,2}[\u2013-](?:[A-Z][a-z]+ )?\d{1,2}):\s+(.+?)\s+[\s.]{6,}(\d+)\s*$/;

  for (const page of pageRows) {
    if (page.pageNumber > 8) break;
    for (const rawLine of page.text.split(/\r?\n/)) {
      const line = normalizeWhitespace(rawLine);
      const match = line.match(dateLine);
      if (!match) continue;
      rows.push({
        dateLabel: normalizeDateLabel(match[1]),
        assignment: normalizeWhitespace(match[2]),
        printedPage: Number(match[3])
      });
    }
  }

  return rows;
}

function parseBodyHeadings(pageRows) {
  const rows = [];
  const headingLine = /^([A-Z]+ \d{1,2}[\u2013-](?:[A-Z]+ )?\d{1,2}):\s+(.+)$/;
  const months = new Set(Object.keys(monthNumbers).map((month) => month.toUpperCase()));

  for (const page of pageRows) {
    const lines = page.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      const line = normalizeWhitespace(lines[index]);
      const match = line.match(headingLine);
      if (!match) continue;

      const firstWord = match[1].split(/\s+/)[0];
      if (!months.has(firstWord)) continue;

      rows.push({
        dateLabel: normalizeDateLabel(toTitleCase(match[1])),
        title: trimOuterQuotes(toTitleCase(match[2])),
        scriptureAssignment: normalizeWhitespace(lines[index + 1] || ""),
        printedPage: firstPrintedPageNumber(lines),
        pdfPageNumber: page.pageNumber
      });
    }
  }

  return rows;
}

function parseDateRange(label) {
  const match = normalizeDateLabel(label).match(/^([A-Z][a-z]+) (\d{1,2})[\u2013-](?:([A-Z][a-z]+) )?(\d{1,2})$/);
  if (!match) {
    throw new Error(`Could not parse date label: ${label}`);
  }

  const startMonth = match[1];
  const startDay = Number(match[2]);
  const endMonth = match[3] || startMonth;
  const endDay = Number(match[4]);
  const startYear = startMonth === "December" && endMonth === "January" ? 2025 : 2026;
  const endYear = 2026;

  return {
    startDate: isoDate(startYear, monthNumbers[startMonth], startDay),
    endDate: isoDate(endYear, monthNumbers[endMonth], endDay)
  };
}

function firstPrintedPageNumber(lines) {
  for (const line of lines.slice(0, 4)) {
    if (/^\d+$/.test(line.trim())) return Number(line.trim());
  }
  return null;
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeDateLabel(value) {
  return normalizeWhitespace(value).replace(/-/g, "\u2013");
}

function normalizeWhitespace(value) {
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

// Title-case that matches the published lesson titles: capitalize the first
// letter of each word but NOT a letter after an apostrophe (so "lord's" stays
// "Lord's", not "Lord'S"), and keep small words (articles/prepositions/short
// conjunctions) lowercase unless they're the first or last word.
function toTitleCase(value) {
  const small = new Set([
    "a", "an", "and", "as", "at", "but", "by", "for", "from", "in",
    "nor", "of", "on", "or", "the", "to", "with"
  ]);
  const tokens = normalizeWhitespace(value).toLowerCase().split(" ");
  const last = tokens.length - 1;
  return tokens
    .map((word, index) => {
      const bare = word.replace(/[^a-z']/g, "");
      if (index !== 0 && index !== last && small.has(bare)) return word;
      // Capitalize the first letter of the word, skipping any leading quote or
      // punctuation. A letter after an apostrophe (the possessive "s") is not
      // the first letter, so it stays lowercase: "lord's" -> "Lord's".
      return word.replace(/[a-z]/, (letter) => letter.toUpperCase());
    })
    .join(" ");
}

function trimOuterQuotes(value) {
  return value.replace(/^["'\u201c]+|["'\u201d]+$/g, "");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
