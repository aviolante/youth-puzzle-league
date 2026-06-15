#!/usr/bin/env node

// Generate a true-Strands puzzle: a letter grid where a set of theme words and
// one spangram are laid out as snaking paths (8-directional adjacency, letters
// used exactly once) that tile the whole grid. The spangram must touch two
// opposite sides of the board.
//
// The packing is an exact-cover-by-snakes search solved with randomized
// backtracking plus connectivity pruning. Output is a reviewed-puzzle JSON in
// the shape the web app consumes.
//
// Usage:
//   npm run content:strands -- --week 2026-week-23
//   npm run content:strands -- --week 2026-week-23 --cols 6 --rows 8 \
//     --spangram REDEEMER --words RUTH,NAOMI,BOAZ,OBED,HANNAH,SAMUEL,SHILOH,GLEAN

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const week = args.week || "2026-week-23";
// Opens Monday 00:00 ET; closes Sunday at midnight ET (= the following Monday
// 00:00 ET, end of Sunday night) — the weekly submission deadline. Override with
// --opensAt / --closesAt if needed.
const weekDates = weekDatesFor(week);

// This week's defaults (Ruth & 1 Samuel). Override with --spangram / --words.
const DEFAULTS = {
  spangram: "REDEEMER",
  words: ["RUTH", "NAOMI", "BOAZ", "OBED", "HANNAH", "SAMUEL", "SHILOH", "GLEAN"],
  title: "Restoration Strands",
  theme: "Ruth & 1 Samuel — people, places, and a promise",
  clue: "Boaz redeemed Ruth's family line. The spangram names what every redeemer points to.",
  opensAt: "2026-06-01T04:00:00Z",
  closesAt: "2026-06-08T03:59:59Z"
};

const spangram = (args.spangram || DEFAULTS.spangram).toUpperCase();
const themeWords = (args.words ? args.words.split(",") : DEFAULTS.words).map((w) => w.trim().toUpperCase());
const cols = Number(args.cols || 6);
const rows = Number(args.rows || 8);

const total = cols * rows;
const letterSum = [spangram, ...themeWords].reduce((sum, w) => sum + w.length, 0);
if (letterSum !== total) {
  console.error(`Letters (${letterSum}) must equal grid cells (${cols}x${rows}=${total}).`);
  console.error("Adjust --words / --spangram / --cols / --rows so they match.");
  process.exit(1);
}

console.log(`Packing ${themeWords.length} theme words + spangram into ${cols}x${rows} (${total} cells)...`);

const solution = solve({ cols, rows, spangram, themeWords });
if (!solution) {
  console.error("Could not pack these words into the grid. Try different words or grid size.");
  process.exit(1);
}

const grid = new Array(total).fill("");
for (const placed of solution) {
  placed.cells.forEach((cellIndex, letterIndex) => {
    grid[cellIndex] = placed.word[letterIndex];
  });
}

const spangramPlacement = solution.find((p) => p.isSpangram);
const puzzle = {
  id: `${week}-strands`,
  title: args.title || DEFAULTS.title,
  type: "strands",
  opensAt: args.opensAt || weekDates?.opensAt || DEFAULTS.opensAt,
  closesAt: args.closesAt || weekDates?.closesAt || DEFAULTS.closesAt,
  theme: args.theme || DEFAULTS.theme,
  clue: args.clue || DEFAULTS.clue,
  instructions: "Find every theme word by linking neighboring letters. One word is the spangram and stretches across the whole board.",
  cols,
  rows,
  grid,
  spangram: { word: spangram, cells: spangramPlacement.cells },
  themeWords: solution
    .filter((p) => !p.isSpangram)
    .map((p) => ({ word: p.word, cells: p.cells }))
};

const verdict = validate(puzzle);
if (!verdict.ok) {
  console.error(`Generated board failed validation: ${verdict.error}`);
  process.exit(1);
}

const outPath = path.join("data/puzzles", `${puzzle.id}.json`);
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(puzzle, null, 2)}\n`);

printGrid(puzzle);
console.log(`\nValidated OK. Wrote ${outPath}`);

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

function solve({ cols, rows, spangram, themeWords }) {
  const total = cols * rows;
  // Spangram first (it has the opposite-sides constraint), then longest words.
  const order = [
    { word: spangram, isSpangram: true },
    ...themeWords.map((word) => ({ word, isSpangram: false })).sort((a, b) => b.word.length - a.word.length)
  ];
  const minRemaining = [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    minRemaining[i] = Math.min(order[i].word.length, minRemaining[i + 1] ?? Infinity);
  }

  // Randomized restarts: each restart re-shuffles the search so we explore
  // different layouts and avoid getting stuck in one dead branch.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const occupied = new Array(total).fill(false);
    // A 2x2 square can hold only one diagonal segment. If a second word's
    // diagonal used the same square it would be the opposite diagonal, which
    // crosses the first — Strands forbids that. Track occupied diagonal squares.
    const usedDiagSquares = new Set();
    const placed = [];
    const budget = { nodes: 60000 };
    if (place(0)) return placed;

    function place(i) {
      if (i === order.length) return hasUniquePaths(placed, cols, rows, total);
      if (budget.nodes-- <= 0) return false;

      const { word, isSpangram } = order[i];
      const starts = shuffle(range(total).filter((cell) => !occupied[cell]));
      for (const start of starts) {
        const result = walk(start, word.length);
        if (!result) continue;
        if (isSpangram && !touchesOppositeSides(result.path, cols, rows)) continue;

        result.path.forEach((cell) => (occupied[cell] = true));
        result.squares.forEach((square) => usedDiagSquares.add(square));
        placed.push({ word, isSpangram, cells: result.path });
        if (coverable(i + 1) && place(i + 1)) return true;
        placed.pop();
        result.path.forEach((cell) => (occupied[cell] = false));
        result.squares.forEach((square) => usedDiagSquares.delete(square));
      }
      return false;
    }

    // Random self-avoiding walk of the given length over empty cells that also
    // never crosses an existing diagonal (its own or another word's).
    function walk(start, length) {
      const path = [start];
      const used = new Set([start]);
      const squares = new Set();
      while (path.length < length) {
        const here = path[path.length - 1];
        const options = shuffle(
          neighbors(here, cols, rows).filter((n) => {
            if (occupied[n] || used.has(n)) return false;
            const square = diagSquare(here, n, cols);
            if (square !== null && (usedDiagSquares.has(square) || squares.has(square))) return false;
            return true;
          })
        );
        if (!options.length) return null;
        const next = options[0];
        const square = diagSquare(here, next, cols);
        if (square !== null) squares.add(square);
        path.push(next);
        used.add(next);
      }
      return { path, squares: [...squares] };
    }

    // Prune: no empty region may be smaller than the smallest remaining word,
    // or it can never be filled.
    function coverable(nextIndex) {
      const floor = minRemaining[nextIndex] ?? Infinity;
      if (floor === Infinity) return true;
      const seen = new Array(total).fill(false);
      for (let cell = 0; cell < total; cell += 1) {
        if (occupied[cell] || seen[cell]) continue;
        let size = 0;
        const stack = [cell];
        seen[cell] = true;
        while (stack.length) {
          const node = stack.pop();
          size += 1;
          for (const n of neighbors(node, cols, rows)) {
            if (!occupied[n] && !seen[n]) {
              seen[n] = true;
              stack.push(n);
            }
          }
        }
        if (size < floor) return false;
      }
      return true;
    }
  }
  return null;
}

// If the step between cells a and b is diagonal, return the index of the 2x2
// square (its top-left cell) the diagonal sits in; otherwise null.
function diagSquare(a, b, cols) {
  const ar = Math.floor(a / cols);
  const ac = a % cols;
  const br = Math.floor(b / cols);
  const bc = b % cols;
  if (ar === br || ac === bc) return null;
  return Math.min(ar, br) * cols + Math.min(ac, bc);
}

// True when every placed word has exactly one legal traceable path in the grid
// the placement produces. Used to reject ambiguous layouts during the search.
function hasUniquePaths(placed, cols, rows, total) {
  const grid = new Array(total).fill("");
  for (const p of placed) p.cells.forEach((cell, li) => (grid[cell] = p.word[li]));
  return placed.every((p) => countSpellings(grid, p.word, cols, rows, 2) === 1);
}

// Counts how many distinct legal paths spell `word` in the grid: 8-directional
// adjacency, each cell used once, and no diagonal that crosses an earlier
// diagonal of the same path (Strands legality). Stops counting at `cap`.
function countSpellings(grid, word, cols, rows, cap = 2) {
  const total = cols * rows;
  let count = 0;

  function dfs(cell, idx, usedCells, usedSquares) {
    if (idx === word.length - 1) {
      count += 1;
      return;
    }
    for (const next of neighbors(cell, cols, rows)) {
      if (count >= cap) return;
      if (usedCells.has(next) || grid[next] !== word[idx + 1]) continue;
      const square = diagSquare(cell, next, cols);
      if (square !== null && usedSquares.has(square)) continue;
      usedCells.add(next);
      if (square !== null) usedSquares.add(square);
      dfs(next, idx + 1, usedCells, usedSquares);
      usedCells.delete(next);
      if (square !== null) usedSquares.delete(square);
    }
  }

  for (let start = 0; start < total && count < cap; start += 1) {
    if (grid[start] !== word[0]) continue;
    dfs(start, 0, new Set([start]), new Set());
  }
  return count;
}

function neighbors(cell, cols, rows) {
  const r = Math.floor(cell / cols);
  const c = cell % cols;
  const result = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) result.push(nr * cols + nc);
    }
  }
  return result;
}

function touchesOppositeSides(path, cols, rows) {
  const r = (cell) => Math.floor(cell / cols);
  const c = (cell) => cell % cols;
  const topBottom = path.some((cell) => r(cell) === 0) && path.some((cell) => r(cell) === rows - 1);
  const leftRight = path.some((cell) => c(cell) === 0) && path.some((cell) => c(cell) === cols - 1);
  return topBottom || leftRight;
}

// ---------------------------------------------------------------------------
// Validation (re-checkable contract for the board the app will load)
// ---------------------------------------------------------------------------

function validate(puzzle) {
  const { cols, rows, grid } = puzzle;
  const total = cols * rows;
  if (grid.length !== total) return { ok: false, error: "grid length mismatch" };

  const owner = new Array(total).fill(-1);
  const all = [{ ...puzzle.spangram, isSpangram: true }, ...puzzle.themeWords];
  for (let i = 0; i < all.length; i += 1) {
    const { word, cells } = all[i];
    if (cells.length !== word.length) return { ok: false, error: `${word} length mismatch` };
    for (let j = 0; j < cells.length; j += 1) {
      const cell = cells[j];
      if (cell < 0 || cell >= total) return { ok: false, error: `${word} cell out of range` };
      if (owner[cell] !== -1) return { ok: false, error: `cell ${cell} used twice` };
      owner[cell] = i;
      if (grid[cell] !== word[j]) return { ok: false, error: `${word} letter mismatch at ${cell}` };
      if (j > 0 && !neighbors(cells[j - 1], cols, rows).includes(cell)) {
        return { ok: false, error: `${word} not contiguous` };
      }
    }
  }
  if (owner.some((o) => o === -1)) return { ok: false, error: "grid not fully covered" };
  if (!touchesOppositeSides(puzzle.spangram.cells, cols, rows)) {
    return { ok: false, error: "spangram does not span opposite sides" };
  }

  // Each word must be traceable exactly one way. If a word can be spelled along
  // a second legal path (e.g. a duplicate letter sits next to the intended one),
  // the intended path is ambiguous — NYT Strands never does this.
  for (const { word } of all) {
    if (countSpellings(grid, word, cols, rows, 2) !== 1) {
      return { ok: false, error: `${word} can be traced more than one way (ambiguous path)` };
    }
  }

  // No two word paths (or one path with itself) may cross: each 2x2 square can
  // hold at most one diagonal segment.
  const diagSquares = new Set();
  for (const { cells } of all) {
    for (let j = 1; j < cells.length; j += 1) {
      const square = diagSquare(cells[j - 1], cells[j], cols);
      if (square === null) continue;
      if (diagSquares.has(square)) return { ok: false, error: "word paths cross" };
      diagSquares.add(square);
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printGrid(puzzle) {
  const { cols, rows, grid } = puzzle;
  const spangramCells = new Set(puzzle.spangram.cells);
  console.log("");
  for (let r = 0; r < rows; r += 1) {
    let line = "";
    for (let c = 0; c < cols; c += 1) {
      const cell = r * cols + c;
      const letter = grid[cell];
      line += spangramCells.has(cell) ? `[${letter}]` : ` ${letter} `;
    }
    console.log(line);
  }
}

function range(n) {
  return Array.from({ length: n }, (_, i) => i);
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Compute opensAt (Mon 00:00 ET) and closesAt (Sunday at midnight ET = the
// following Mon 00:00 ET, end of Sunday night) for a "2026-week-NN" id, handling
// US Eastern DST.
function weekDatesFor(weekId) {
  const match = /^(\d{4})-week-(\d{1,2})$/.exec(String(weekId));
  if (!match) return null;
  const monday = isoWeekMonday(Number(match[1]), Number(match[2]));
  const close = new Date(monday);
  close.setUTCDate(monday.getUTCDate() + 7); // next Monday 00:00 ET = end of Sunday
  return { opensAt: etMidnightUtc(monday), closesAt: etMidnightUtc(close) };
}

function isoWeekMonday(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - day + 1 + (week - 1) * 7);
  return monday;
}

// Midnight (00:00) Eastern for the given UTC date, expressed as a UTC instant.
function etMidnightUtc(date) {
  const iso = date.toISOString().slice(0, 10);
  const offset = isEasternDst(date) ? 4 : 5; // EDT = UTC-4, EST = UTC-5
  return `${iso}T${String(offset).padStart(2, "0")}:00:00Z`;
}

function isEasternDst(date) {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 2, nthSunday(y, 2, 2)); // 2nd Sunday of March
  const end = Date.UTC(y, 10, nthSunday(y, 10, 1)); // 1st Sunday of November
  return date.getTime() >= start && date.getTime() < end;
}

function nthSunday(year, monthIndex, n) {
  const firstDow = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
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
