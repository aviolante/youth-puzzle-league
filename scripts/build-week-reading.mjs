#!/usr/bin/env node

// Build a clean, puzzle-ready scripture text file for one Come Follow Me week.
//
// Given a week (by date, by CFM start date, or by 2026-week-NN id) this script:
//   1. Looks up the week's scriptureAssignment in the CFM assignments file.
//   2. Parses that assignment into (book, chapter-range) segments.
//   3. Resolves each segment to a PDF page range using the running headers
//      already present in the extracted *.pages.jsonl files.
//   4. Slices and cleans those pages (drops page numbers / running headers,
//      strips footnote markers, de-hyphenates, reflows verses).
//   5. Writes content/processed/readings/<week-id>.txt plus a .json sidecar.
//
// Output is local-only draft material that feeds puzzle generation. It is not
// committed scripture text and still wants a human eye before publishing.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { readJsonl } from "./lib/jsonl.mjs";

// Books that live in the Pearl of Great Price trio PDF rather than the OT PDF.
const PGP_BOOKS = new Set(["moses", "abraham"]);

const SOURCE_FILES = {
  "old-testament": "content/processed/text/old-testament.pages.jsonl",
  trio: "content/processed/text/book-of-mormon-doctrine-and-convenants-pearl-of-great-price-trio.pages.jsonl"
};

// Weeks with no scripture chapters to slice.
const NON_SCRIPTURE = /^(introduction|easter|christmas)/i;

const args = parseArgs(process.argv.slice(2));
const assignmentsPath =
  args.assignments || "content/processed/cfm/come-follow-me-old-testament-2026-assignments.json";
const outputDir = args.outdir || "content/processed/readings";

const assignmentsDoc = JSON.parse(await readFile(assignmentsPath, "utf8"));
const assignment = selectAssignment(assignmentsDoc.assignments, args);
if (!assignment) {
  console.error("Could not find a CFM week for the given selector.");
  console.error("Use --date YYYY-MM-DD, --start YYYY-MM-DD, or --week 2026-week-NN.");
  process.exit(1);
}

const weekId = weekIdFor(assignment);
console.log(`Week: ${assignment.dateLabel}  (${assignment.startDate} → ${assignment.endDate})`);
console.log(`Title: ${assignment.title}`);
console.log(`Reading: ${assignment.scriptureAssignment}`);

if (NON_SCRIPTURE.test(assignment.scriptureAssignment)) {
  console.log("\nThis week has no scripture chapter reading to slice. Nothing written.");
  process.exit(0);
}

const segments = parseAssignment(assignment.scriptureAssignment);

// Resolve every segment to page ranges, grouped by source PDF so we only load
// each pages.jsonl once.
const pageCache = new Map();
const resolved = [];
for (const segment of segments) {
  const sourceKey = PGP_BOOKS.has(segment.book.toLowerCase()) ? "trio" : "old-testament";
  const index = await loadPageIndex(sourceKey, pageCache);
  const range = resolvePageRange(index, segment.book, segment.chapterStart, segment.chapterEnd);
  if (!range) {
    console.warn(`  ! Could not locate ${describeSegment(segment)} in ${sourceKey}`);
    continue;
  }
  resolved.push({ ...segment, sourceKey, ...range });
  console.log(`  - ${describeSegment(segment).padEnd(28)} pages ${range.startPage}-${range.endPage}`);
}

if (!resolved.length) {
  console.error("\nNo readable page ranges were resolved. Nothing written.");
  process.exit(1);
}

// The Pearl of Great Price pages (Moses/Abraham) use a different chapter-start
// layout than the Old Testament PDF, so those extracts can begin mid-chapter.
// Old Testament readings are clean. All 2026 CFM weeks from June on are OT.
if (resolved.some((segment) => segment.sourceKey === "trio")) {
  console.warn(
    "\n  ! Pearl of Great Price (Moses/Abraham) extract — verify the opening verses by hand."
  );
}

// Collect the union of pages (sorted, de-duplicated) and clean each one.
const sections = [];
const pageNumbers = new Set();
for (const segment of resolved) {
  const index = pageCache.get(segment.sourceKey);
  const lines = [];
  for (let pageNumber = segment.startPage; pageNumber <= segment.endPage; pageNumber += 1) {
    const page = index.byNumber.get(pageNumber);
    if (!page) continue;
    pageNumbers.add(`${segment.sourceKey}:${pageNumber}`);
    lines.push(cleanPageText(page.text));
  }
  sections.push({
    heading: describeSegment(segment),
    text: trimToChapters(reflow(lines.join("\n")), segment)
  });
}

const body = sections
  .map((section) => `## ${section.heading}\n\n${section.text}`)
  .join("\n\n");
const header = [
  `# ${assignment.title}`,
  ``,
  `Come Follow Me — ${assignment.dateLabel} (${assignment.startDate} to ${assignment.endDate})`,
  `Reading: ${assignment.scriptureAssignment}`,
  ``,
  `Draft local extract for puzzle generation. Page-aligned, so a few neighboring`,
  `verses may appear at chapter boundaries. Review before publishing.`,
  ``,
  `---`,
  ``
].join("\n");
const textOut = `${header}${body}\n`;

await mkdir(outputDir, { recursive: true });
const textPath = path.join(outputDir, `${weekId}.txt`);
const jsonPath = path.join(outputDir, `${weekId}.json`);
await writeFile(textPath, textOut);
await writeFile(
  jsonPath,
  `${JSON.stringify(
    {
      weekId,
      assignmentId: assignment.id,
      dateLabel: assignment.dateLabel,
      startDate: assignment.startDate,
      endDate: assignment.endDate,
      title: assignment.title,
      scriptureAssignment: assignment.scriptureAssignment,
      segments: resolved.map((segment) => ({
        reference: describeSegment(segment),
        source: segment.sourceKey,
        startPage: segment.startPage,
        endPage: segment.endPage
      })),
      pageCount: pageNumbers.size,
      characters: textOut.length,
      textFile: textPath
    },
    null,
    2
  )}\n`
);

console.log(`\nWrote ${textPath}`);
console.log(`Wrote ${jsonPath}`);
console.log(`Pages: ${pageNumbers.size}   Characters: ${textOut.length}`);

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function selectAssignment(assignments, options) {
  if (options.start) {
    return assignments.find((row) => row.startDate === options.start) || null;
  }
  if (options.week) {
    const target = isoWeekKeyFromWeekId(options.week);
    if (target) {
      const match = assignments.find((row) => isoWeekKey(row.startDate) === target);
      if (match) return match;
    }
  }
  // Default to a containing date (explicit --date, else today).
  const date = options.date || todayIso();
  return (
    assignments.find((row) => row.startDate <= date && date <= row.endDate) || null
  );
}

function weekIdFor(assignment) {
  const { year, week } = isoWeekParts(assignment.startDate);
  return `${year}-week-${String(week).padStart(2, "0")}`;
}

function isoWeekKeyFromWeekId(weekId) {
  const match = /^(\d{4})-week-(\d{1,2})$/.exec(weekId.trim());
  if (!match) return null;
  return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}`;
}

function isoWeekKey(isoDate) {
  const { year, week } = isoWeekParts(isoDate);
  return `${year}-${String(week).padStart(2, "0")}`;
}

function isoWeekParts(isoDate) {
  // ISO 8601 week number (weeks start Monday; week 1 contains the first Thursday).
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7; // Sunday -> 7
  date.setUTCDate(date.getUTCDate() + 4 - day); // shift to Thursday of this week
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return { year, week };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Assignment parsing
// ---------------------------------------------------------------------------

function parseAssignment(assignmentText) {
  const segments = [];
  let currentBook = null;
  for (const rawPart of assignmentText.split(";")) {
    const part = normalize(rawPart);
    if (!part) continue;

    // A part is either "<Book> <chapters>", "<Book>" (whole book), or just
    // "<chapters>" which inherits the previous book.
    const match = /^((?:[1-3]\s)?[A-Za-z][A-Za-z ]*?)(?:\s+(\d.*))?$/.exec(part);
    let book = currentBook;
    let chapterSpec = part;
    if (match && match[1]) {
      book = normalizeBook(match[1]);
      chapterSpec = (match[2] || "").trim();
      currentBook = book;
    }
    if (!book) continue;

    if (!chapterSpec) {
      segments.push({ book, chapterStart: 1, chapterEnd: Infinity, whole: true });
      continue;
    }
    const range = parseChapterRange(chapterSpec);
    if (range) segments.push({ book, ...range, whole: false });
  }
  return segments;
}

function parseChapterRange(spec) {
  const match = /^(\d+)\s*[–—-]\s*(\d+)$/.exec(spec) || /^(\d+)$/.exec(spec);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  return { chapterStart: start, chapterEnd: end };
}

function describeSegment(segment) {
  if (segment.whole) return segment.book;
  if (segment.chapterStart === segment.chapterEnd) {
    return `${segment.book} ${segment.chapterStart}`;
  }
  return `${segment.book} ${segment.chapterStart}-${segment.chapterEnd}`;
}

// ---------------------------------------------------------------------------
// Page index (built from running headers)
// ---------------------------------------------------------------------------

async function loadPageIndex(sourceKey, cache) {
  if (cache.has(sourceKey)) return cache.get(sourceKey);
  const file = SOURCE_FILES[sourceKey];
  if (!file) throw new Error(`Unknown source key: ${sourceKey}`);
  const pages = await readJsonl(file);
  const index = buildPageIndex(pages);
  cache.set(sourceKey, index);
  return index;
}

function buildPageIndex(pages) {
  const byNumber = new Map();
  const headerByPage = new Map();
  const chapterStartPages = [];

  for (const page of pages) {
    byNumber.set(page.pageNumber, page);
    const lines = page.text.split(/\r?\n/).map((line) => line.trim());
    const first = lines.find((line) => line.length > 0) || "";

    if (/^\d+$/.test(first)) {
      // Normal page: page number then a running header on the next non-empty line.
      const rest = lines.filter((line) => line.length > 0).slice(1);
      const header = parseHeader(rest[0] || "");
      if (header) headerByPage.set(page.pageNumber, header);
    } else {
      const chapterMatch = /^Chapter\s+(\d+)$/.exec(first);
      if (chapterMatch) chapterStartPages.push({ pageNumber: page.pageNumber, chapter: Number(chapterMatch[1]) });
    }
  }

  // Coverage entry per page: which book + chapter span the page contains.
  const coverage = [];
  for (const [pageNumber, header] of headerByPage) {
    const sameBook = !header.endBook || sameBookName(header.endBook, header.startBook);
    coverage.push({
      pageNumber,
      book: header.startBook,
      startChap: header.startChap,
      endChap: sameBook ? header.endChap : Infinity
    });
    // Boundary page that crosses into the next book (e.g. "Amos 9:14-Obadiah 1:12").
    if (!sameBook) {
      coverage.push({
        pageNumber,
        book: header.endBook,
        startChap: header.endChap,
        endChap: header.endChap
      });
    }
  }

  // Book-start pages have no header; borrow the book from the next headered page.
  const sortedHeaders = [...headerByPage.entries()].sort((a, b) => a[0] - b[0]);
  for (const { pageNumber, chapter } of chapterStartPages) {
    const next = sortedHeaders.find(([n]) => n > pageNumber);
    if (!next) continue;
    const nextHeader = next[1];
    coverage.push({
      pageNumber,
      book: nextHeader.startBook,
      startChap: chapter,
      endChap: Math.max(chapter, nextHeader.startChap)
    });
  }

  return { byNumber, coverage };
}

function parseHeader(line) {
  const text = normalize(line);
  const start = /^((?:[1-3]\s)?[A-Za-z][A-Za-z ]*?)\s+(\d+):(\d+)/.exec(text);
  if (!start) return null;
  if (!/[–—-]/.test(text)) return null; // must be a range header

  const startBook = normalizeBook(start[1]);
  const startChap = Number(start[2]);

  const endPart = text.split(/[–—-]/).pop().trim();
  const endMatch = /^(?:((?:[1-3]\s)?[A-Za-z][A-Za-z ]*?)\s+)?(\d+)(?::(\d+))?$/.exec(endPart);
  let endBook = null;
  let endChap = startChap;
  if (endMatch) {
    if (endMatch[1]) endBook = normalizeBook(endMatch[1]);
    // "8:13" -> chapter 8; bare "18" -> verse only, same chapter.
    endChap = endMatch[3] ? Number(endMatch[2]) : endBook ? Number(endMatch[2]) : startChap;
  }
  return { startBook, startChap, endBook, endChap };
}

function resolvePageRange(index, book, chapterStart, chapterEnd) {
  const matches = index.coverage.filter(
    (entry) =>
      sameBookName(entry.book, book) &&
      entry.startChap <= chapterEnd &&
      entry.endChap >= chapterStart
  );
  if (!matches.length) return null;
  const pages = matches.map((entry) => entry.pageNumber);
  return { startPage: Math.min(...pages), endPage: Math.max(...pages) };
}

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

function cleanPageText(rawText) {
  // \u00a0 (nbsp) separates verse numbers from text; \u200a (hair space) glues
  // a footnote marker letter to the following word ("a\u200ajudges"). Drop the
  // marker letter along with the hair space.
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\u00a0/g, " ").replace(/[A-Za-z]?\u200a/g, "").replace(/\s+$/, ""));

  // The footnote apparatus (cross-references, topical-guide / Hebrew notes) and
  // the book-title footer sit at the bottom of every page. They begin with an
  // entry like "16 c tg Brotherhood" or "1 1 a Judg. 2:16" and run to the page
  // end, so truncate from the first such line.
  const cut = lines.findIndex(isFootnoteLine);
  let body;
  if (cut === -1) {
    body = lines;
  } else {
    body = lines.slice(0, cut);
    // The footnote block does not always run to the page end. This PDF is
    // two-column, and where a book finishes partway down a page the extractor
    // emits that page's footnotes before the text that follows them — so
    // truncating at the first footnote line drops real scripture (Psalm 1
    // shares a page with the end of Job). Resume at the next chapter/psalm
    // heading, which footnote and cross-reference lines never look like.
    const rest = lines.slice(cut + 1);
    const resume = rest.findIndex((line) => isSectionHeading(line.trim()));
    if (resume !== -1) body = body.concat(rest.slice(resume));
  }

  const kept = [];
  for (let line of body) {
    line = line.trim();
    if (!line) continue;
    if (/^\d+$/.test(line)) continue; // bare page number
    if (isHeaderLine(line)) continue; // running header
    if (isFooterLine(line)) continue; // book-title footer
    kept.push(line);
  }

  // Merge dropcap lines (a single capital letter that begins the first verse).
  for (let i = 0; i < kept.length - 1; i += 1) {
    if (/^[A-Z]$/.test(kept[i])) {
      kept[i + 1] = kept[i] + kept[i + 1];
      kept[i] = "";
    }
  }
  return kept.filter(Boolean).join("\n");
}

// A standalone "Chapter 12" / "Psalm 23" heading — the marker that a new
// chapter's body text starts here.
function isSectionHeading(line) {
  return /^(?:Chapter|Psalm)\s+\d+$/i.test(line);
}

function isHeaderLine(line) {
  return /^(?:[1-3]\s)?[A-Za-z][A-Za-z ]*\s\d+:\d+\s?[–—-]/.test(line);
}

function isFootnoteLine(line) {
  // Optional leading chapter/verse numbers, a single lowercase marker letter,
  // then a note keyword (tg/ie/or/heb/jst/gr) or an abbreviated reference,
  // including numbered books ("Gen.", "1 Sam.", "2 Chr.").
  return /^\s*(?:\d+\s+)*[a-z]\s+(?:tg|ie|or|heb|jst|gr|(?:[1-3]\s)?[A-Z][A-Za-z]*\.)/.test(line);
}

function isFooterLine(line) {
  return /^(?:The )?(?:First |Second |Third )?Book of\b/i.test(line);
}

function reflow(text) {
  const lines = text.split(/\r?\n/);
  let out = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Keep chapter headings on their own line for structure.
    if (/^Chapter\s+\d+$/.test(line)) {
      out += `${out ? "\n\n" : ""}${line}\n`;
      continue;
    }

    if (!out || out.endsWith("\n")) {
      out += line;
    } else if (/[\u00ad-]$/.test(out)) {
      out = out.replace(/[\u00ad-]$/, "") + line; // de-hyphenate across the break
    } else {
      out += ` ${line}`;
    }
  }
  // Strip leftover footnote markers and tidy spacing.
  return out
    .replace(/\u00ad/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ \n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Page slices are page-aligned, so the first/last page can spill a neighboring
// chapter. Use the "Chapter N" markers to clip a chapter-ranged segment back to
// the chapters it actually asked for. Whole-book segments are left untouched.
function trimToChapters(text, segment) {
  if (segment.whole) return text;
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  let started = false;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^Chapter\s+(\d+)$/.exec(lines[i].trim());
    if (!match) continue;
    const chapter = Number(match[1]);
    if (!started && chapter <= segment.chapterStart) {
      start = i;
      if (chapter === segment.chapterStart) started = true;
    }
    // Only treat a higher chapter number as the end once we have actually
    // entered this segment. A segment's first page often carries the tail of
    // the previous book, whose chapter numbers can exceed chapterEnd (Job 1
    // shares a page with Esther 10) — breaking there would drop the whole
    // reading and leave only the previous book's text.
    if (started && chapter > segment.chapterEnd) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(text) {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeBook(name) {
  const clean = normalize(name);
  if (/^psalms?$/i.test(clean)) return "Psalms";
  return clean;
}

function sameBookName(a, b) {
  return normalizeBook(a).toLowerCase() === normalizeBook(b).toLowerCase();
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
