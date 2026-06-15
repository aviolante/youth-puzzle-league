#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./lib/env.mjs";

loadEnv(); // pick up PQ_GOOGLE_SCRIPT_URL / PQ_ADMIN_KEY from a local .env

const args = parseArgs(process.argv.slice(2));
const rootDir = process.cwd();

// Admins (leaders) are excluded from rankings by default. --exclude id1,id2 or
// PQ_EXCLUDE_PLAYER_IDS adds more; --include-admins keeps everyone.
const includeAdmins = Boolean(args["include-admins"]);
const extraExcluded = new Set(
  String(args.exclude || process.env.PQ_EXCLUDE_PLAYER_IDS || "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean)
);

// Tiered floors. Attempting a game (a Run row, finished or not) is worth at least
// ATTEMPT_FLOOR. Finishing it is worth at least COMPLETE_FLOOR, plus a speed bonus
// up to the 1000 ceiling: a completed game scores max(COMPLETE_FLOOR, computed),
// and computed is already capped at 1000.
const ATTEMPT_FLOOR = 100;
const COMPLETE_FLOOR = 200;

// --auto finalizes every connections puzzle whose deadline has passed and which
// has not been finalized yet (for the scheduled GitHub Action). Otherwise a
// single puzzle is finalized (--puzzle, or the current one).
const targets = args.auto
  ? await autoTargets()
  : [args.puzzle || args.p || (await readJson(path.join(rootDir, "data/current.json"))).puzzleId];

if (!targets.length || !targets[0]) {
  if (args.auto) {
    console.log("Auto: no closed puzzles awaiting finalization.");
    process.exit(0);
  }
  fail("Missing puzzle id. Use --puzzle 2026-week-23 (or --auto).");
}

let finalized = 0;
for (const id of targets) {
  if (await finalizeOne(id)) finalized += 1;
}
if (args.auto) console.log(`Auto: finalized ${finalized} puzzle(s).`);

// Connections puzzles whose closesAt has passed and that lack a finalized board.
async function autoTargets() {
  const now = Date.now();
  const dir = path.join(rootDir, "data/puzzles");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
  const ids = [];
  for (const file of files) {
    const puzzle = await readJson(path.join(dir, file), null);
    if (!puzzle || puzzle.type !== "connections") continue;
    if (!puzzle.closesAt || new Date(puzzle.closesAt).getTime() > now) continue;
    const existing = await readJson(path.join(rootDir, `data/leaderboards/${puzzle.id}.json`), null);
    if (existing && existing.finalizedAt) continue;
    ids.push(puzzle.id);
  }
  return ids;
}

// A "week" combines its Connections puzzle (the id, e.g. 2026-week-23) and its
// Strands puzzle (<id>-strands) into one board: each game's score plus a weekly
// total. The season is the running total of those weekly totals.
async function finalizeOne(connectionsId) {
  const connPuzzle = await readJson(path.join(rootDir, `data/puzzles/${connectionsId}.json`), {});
  const strandsId = `${connectionsId}-strands`;
  const strandsPuzzle = await readJson(path.join(rootDir, `data/puzzles/${strandsId}.json`), null);

  const conn = await loadPuzzleData(connectionsId);
  const strands = strandsPuzzle ? await loadPuzzleData(strandsId) : { submissions: [], runs: [] };
  const adminIds = collectAdminIds([...conn.submissions, ...strands.submissions]);
  const roster = await fetchRoster(); // full active roster (names), or null in CSV mode

  const connBest = bestByPlayer(conn.submissions, conn.runs, connectionsId, connPuzzle.closesAt, adminIds);
  const strandsBest = strandsPuzzle
    ? bestByPlayer(strands.submissions, strands.runs, strandsId, strandsPuzzle.closesAt, adminIds)
    : new Map();

  const weekly = buildWeekly(connectionsId, connBest, strandsBest, roster, adminIds);
  const seasonPreview = await buildSeasonPreview(weekly);

  if (args["dry-run"]) {
    console.log(JSON.stringify({ weekly, season: seasonPreview }, null, 2));
    return false;
  }

  await mkdir(path.join(rootDir, "data/leaderboards"), { recursive: true });
  await writeJson(path.join(rootDir, `data/leaderboards/${connectionsId}.json`), weekly);
  await writeJson(path.join(rootDir, "data/leaderboards/season.json"), seasonPreview);
  console.log(`Finalized ${weekly.standings.length} players for ${connectionsId} (Connections + Strands).`);
  return true;
}

// Best result per player for one puzzle id. A finished game uses the first
// completed, on-time submission (score floored at COMPLETE_FLOOR); a player who
// only has a Run row (started but never finished) gets the flat ATTEMPT_FLOOR.
// Admins and --exclude ids are dropped from both.
function bestByPlayer(rows, runs, targetPuzzleId, closesAt, adminIds) {
  const deadline = closesAt ? new Date(closesAt).getTime() : null;
  const onTime = (row) => !deadline || new Date(row.submittedAt).getTime() <= deadline;
  const isExcludedId = (id) =>
    extraExcluded.has(id.toLowerCase()) || (!includeAdmins && adminIds.has(id.toLowerCase()));

  const best = new Map();

  // Finished games: real score, floored at the participation minimum.
  rows
    .map(normalizeSubmission)
    .filter((row) => row.puzzleId === targetPuzzleId && row.completed && !row.duplicateOf && !isExcludedId(row.playerId) && onTime(row))
    .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))
    .forEach((row) => {
      if (!best.has(row.playerId)) {
        best.set(row.playerId, {
          displayName: row.displayName,
          score: Math.max(COMPLETE_FLOOR, calculateScore(row.elapsedMs, row.mistakes, row.hintsUsed)),
          elapsedMs: row.elapsedMs,
          completed: true
        });
      }
    });

  // Attempts: a Run with no finished submission earns the flat floor (no time).
  runs
    .map(normalizeRun)
    .filter((run) => run.puzzleId === targetPuzzleId && !isExcludedId(run.playerId))
    .forEach((run) => {
      if (!best.has(run.playerId)) {
        best.set(run.playerId, {
          displayName: run.displayName,
          score: ATTEMPT_FLOOR,
          elapsedMs: 0,
          completed: false
        });
      }
    });

  return best;
}

// Builds the weekly board. If a roster is provided, EVERY active non-admin
// player is listed; players who never attempted a game get null scores
// (rendered as 🥚). Attempting a game earns ATTEMPT_FLOOR.
function buildWeekly(weekId, connBest, strandsBest, roster, adminIds) {
  let players;
  if (roster && roster.length) {
    players = roster
      .filter((p) => {
        const id = String(p.playerId).toLowerCase();
        const isAdmin = p.admin === true || (adminIds && adminIds.has(id));
        return !extraExcluded.has(id) && !(!includeAdmins && isAdmin);
      })
      .map((p) => ({ playerId: p.playerId, displayName: p.displayName }));
  } else {
    const ids = new Set([...connBest.keys(), ...strandsBest.keys()]);
    players = [...ids].map((id) => ({ playerId: id, displayName: (connBest.get(id) || strandsBest.get(id)).displayName }));
  }

  const standings = players
    .map(({ playerId, displayName }) => {
      const c = connBest.get(playerId) || null;
      const s = strandsBest.get(playerId) || null;
      // Only finished games contribute completion time (attempts have none).
      const completedCount = (c?.completed ? 1 : 0) + (s?.completed ? 1 : 0);
      const totalTime = (c?.completed ? c.elapsedMs : 0) + (s?.completed ? s.elapsedMs : 0);
      return {
        playerId,
        displayName: displayName || (c || s)?.displayName || playerId,
        connectionsScore: c ? c.score : null,
        strandsScore: s ? s.score : null,
        total: (c?.score || 0) + (s?.score || 0),
        played: Boolean(c || s),
        completedCount,
        totalTime,
        formattedTime: completedCount ? formatTime(totalTime) : null
      };
    })
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      if (b.completedCount !== a.completedCount) return b.completedCount - a.completedCount;
      if (a.totalTime !== b.totalTime) return a.totalTime - b.totalTime;
      return a.displayName.localeCompare(b.displayName);
    })
    // Published rows carry only the display name + scores — no playerId (which
    // encodes surnames) and no internal sort fields. See the privacy rule.
    .map((row, index) => ({
      rank: index + 1,
      displayName: row.displayName,
      connectionsScore: row.connectionsScore,
      strandsScore: row.strandsScore,
      total: row.total,
      played: row.played,
      formattedTime: row.formattedTime
    }));

  return {
    puzzleId: weekId,
    finalizedAt: new Date().toISOString(),
    scoring: {
      rawScore: "finished game: max(200, 1000 - elapsedSeconds*1 - mistakes*25 - hintsUsed*50) (capped at 1000); attempted but unfinished: 100",
      weekTotal: "Connections score + Strands score"
    },
    standings
  };
}

// All active players from the Sheet. Prefers the admin-key-gated export roster
// (includes the admin flag, kept private); falls back to the public players
// list (names only). Null in CSV (--input) mode.
async function fetchRoster() {
  const endpoint = args.endpoint || process.env.PQ_GOOGLE_SCRIPT_URL;
  if (args.input || !endpoint) return null;
  const adminKey = args["admin-key"] || process.env.PQ_ADMIN_KEY;

  if (adminKey) {
    try {
      const url = new URL(endpoint);
      url.searchParams.set("action", "export");
      url.searchParams.set("adminKey", adminKey);
      const payload = await (await fetch(url)).json();
      if (payload.ok && Array.isArray(payload.roster)) return payload.roster;
    } catch {
      /* fall through to public list */
    }
  }
  try {
    const url = new URL(endpoint);
    url.searchParams.set("action", "players");
    const payload = await (await fetch(url)).json();
    return payload.ok ? payload.players || [] : null;
  } catch {
    return null;
  }
}

// Player ids that are admins (from the admin-flagged export rows).
function collectAdminIds(rows) {
  const ids = new Set();
  rows.map(normalizeSubmission).forEach((row) => {
    if (row.admin) ids.add(row.playerId.toLowerCase());
  });
  return ids;
}

async function buildSeasonPreview(weekly) {
  const seasonPath = path.join(rootDir, "data/leaderboards/season.json");
  const season = await readJson(seasonPath, { updatedAt: "", weeks: {}, standings: [] });
  season.updatedAt = new Date().toISOString();
  season.weeks = season.weeks || {};
  // Store only players who actually played this week (attempted a game) — the
  // 🪿 no-shows don't count toward weeks-played or the average.
  season.weeks[weekly.puzzleId] = weekly.standings
    .filter((row) => row.played)
    .map((row) => ({ displayName: row.displayName, total: row.total }));
  season.standings = buildSeasonStandings(season.weeks);
  return season;
}

async function loadPuzzleData(puzzleId) {
  if (args.input) {
    // CSV mode has no Runs data, so attempts == finished games here.
    const csv = await readFile(path.resolve(rootDir, args.input), "utf8");
    return { submissions: parseCsv(csv), runs: [] };
  }

  const endpoint = args.endpoint || process.env.PQ_GOOGLE_SCRIPT_URL;
  const adminKey = args["admin-key"] || process.env.PQ_ADMIN_KEY;

  if (!endpoint || !adminKey) {
    fail("Provide --endpoint and --admin-key, set PQ_GOOGLE_SCRIPT_URL and PQ_ADMIN_KEY, or pass --input submissions.csv.");
  }

  const url = new URL(endpoint);
  url.searchParams.set("action", "export");
  url.searchParams.set("adminKey", adminKey);
  url.searchParams.set("puzzleId", puzzleId);

  const response = await fetch(url);
  if (!response.ok) {
    fail(`Export failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (!payload.ok) {
    fail(payload.error || "Export failed.");
  }

  return { submissions: payload.submissions || [], runs: payload.runs || [] };
}

// Season = running total of each week's combined (Connections + Strands) score.
// Keyed on display name (the published files carry no playerId), so display
// names must stay unique per player — they already are (first name + last initial).
// weeksPlayed counts only weeks the player actually played (total > 0); the
// `total <= 0` guard also drops 🪿 rows left over in any older season weeks.
// averageScore = totalScore / weeksPlayed, so a late starter isn't penalized for
// missing earlier weeks.
function buildSeasonStandings(weeks) {
  const totals = new Map();

  Object.values(weeks).forEach((weekRows) => {
    weekRows.forEach((row) => {
      if (Number(row.total || 0) <= 0) return;
      const current = totals.get(row.displayName) || {
        displayName: row.displayName,
        totalScore: 0,
        weeksPlayed: 0
      };
      current.totalScore += Number(row.total || 0);
      current.weeksPlayed += 1;
      totals.set(row.displayName, current);
    });
  });

  return [...totals.values()]
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if (b.weeksPlayed !== a.weeksPlayed) return b.weeksPlayed - a.weeksPlayed;
      return a.displayName.localeCompare(b.displayName);
    })
    .map((row, index) => ({
      rank: index + 1,
      displayName: row.displayName,
      totalScore: row.totalScore,
      weeksPlayed: row.weeksPlayed,
      averageScore: row.weeksPlayed ? Math.round(row.totalScore / row.weeksPlayed) : 0
    }));
}

function normalizeSubmission(row) {
  return {
    submissionId: String(row.submissionId || ""),
    runId: String(row.runId || ""),
    puzzleId: String(row.puzzleId || ""),
    playerId: String(row.playerId || ""),
    displayName: String(row.displayName || row.playerId || ""),
    startedAt: String(row.startedAt || ""),
    submittedAt: String(row.submittedAt || ""),
    elapsedMs: Number(row.elapsedMs || 0),
    mistakes: Number(row.mistakes || 0),
    hintsUsed: Number(row.hintsUsed || 0),
    rawScore: Number(row.rawScore || 0),
    completed: String(row.completed).toLowerCase() === "true" || row.completed === true,
    duplicateOf: String(row.duplicateOf || ""),
    admin: String(row.admin).toLowerCase() === "true" || row.admin === true
  };
}

function normalizeRun(row) {
  return {
    puzzleId: String(row.puzzleId || ""),
    playerId: String(row.playerId || ""),
    displayName: String(row.displayName || row.playerId || "")
  };
}

function calculateScore(elapsedMs, mistakes, hintsUsed = 0) {
  const elapsedSeconds = Math.floor(Number(elapsedMs || 0) / 1000);
  return Math.max(0, 1000 - elapsedSeconds * 1 - Number(mistakes || 0) * 25 - Number(hintsUsed || 0) * 50);
}

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const headers = rows.shift() || [];
  return rows
    .filter((cells) => cells.some((value) => value !== ""))
    .map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]))
    );
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
