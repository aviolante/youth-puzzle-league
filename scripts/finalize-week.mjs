#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const rootDir = process.cwd();

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

async function finalizeOne(puzzleId) {
  const puzzle = await readJson(path.join(rootDir, `data/puzzles/${puzzleId}.json`), {});
  const submissions = await loadSubmissions(puzzleId);
  const weekly = finalizeWeekly(submissions, puzzleId, puzzle.closesAt);
  const seasonPreview = await buildSeasonPreview(weekly);

  if (args["dry-run"]) {
    console.log(JSON.stringify({ weekly, season: seasonPreview }, null, 2));
    return false;
  }

  await mkdir(path.join(rootDir, "data/leaderboards"), { recursive: true });
  await writeJson(path.join(rootDir, `data/leaderboards/${puzzleId}.json`), weekly);
  await writeJson(path.join(rootDir, "data/leaderboards/season.json"), seasonPreview);
  console.log(`Finalized ${weekly.standings.length} scores for ${puzzleId}.`);
  return true;
}

async function buildSeasonPreview(weeklyResults) {
  const seasonPath = path.join(rootDir, "data/leaderboards/season.json");
  const season = await readJson(seasonPath, { updatedAt: "", weeks: {}, standings: [] });
  season.updatedAt = new Date().toISOString();
  season.weeks = season.weeks || {};
  season.weeks[weeklyResults.puzzleId] = weeklyResults.standings.map((row) => ({
    playerId: row.playerId,
    displayName: row.displayName,
    rank: row.rank,
    weeklyPoints: row.weeklyPoints,
    rawScore: row.rawScore,
    elapsedMs: row.elapsedMs,
    mistakes: row.mistakes
  }));
  season.standings = buildSeasonStandings(season.weeks);
  return season;
}

async function loadSubmissions(puzzleId) {
  if (args.input) {
    const csv = await readFile(path.resolve(rootDir, args.input), "utf8");
    return parseCsv(csv);
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

  return payload.submissions || [];
}

function finalizeWeekly(rows, targetPuzzleId, closesAt) {
  const officialByPlayer = new Map();
  const deadline = closesAt ? new Date(closesAt).getTime() : null;
  const onTime = (row) => !deadline || new Date(row.submittedAt).getTime() <= deadline;

  // Admins (e.g. leaders) are excluded from rankings by default. Extra ids can
  // be excluded with --exclude id1,id2 or PQ_EXCLUDE_PLAYER_IDS; --include-admins
  // keeps everyone.
  const includeAdmins = Boolean(args["include-admins"]);
  const extraExcluded = new Set(
    String(args.exclude || process.env.PQ_EXCLUDE_PLAYER_IDS || "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean)
  );
  const isExcluded = (row) =>
    extraExcluded.has(row.playerId.toLowerCase()) || (!includeAdmins && row.admin);

  rows
    .map(normalizeSubmission)
    .filter((row) => row.puzzleId === targetPuzzleId && row.completed && !row.duplicateOf && !isExcluded(row) && onTime(row))
    .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))
    .forEach((row) => {
      if (!officialByPlayer.has(row.playerId)) {
        officialByPlayer.set(row.playerId, row);
      }
    });

  const standings = [...officialByPlayer.values()]
    .map((row) => ({
      ...row,
      rawScore: calculateScore(row.elapsedMs, row.mistakes, row.hintsUsed)
    }))
    .sort((a, b) => {
      if (b.rawScore !== a.rawScore) return b.rawScore - a.rawScore;
      if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
      if (a.mistakes !== b.mistakes) return a.mistakes - b.mistakes;
      return a.displayName.localeCompare(b.displayName);
    })
    .map((row, index) => ({
      rank: index + 1,
      playerId: row.playerId,
      displayName: row.displayName,
      elapsedMs: row.elapsedMs,
      formattedTime: formatTime(row.elapsedMs),
      mistakes: row.mistakes,
      hintsUsed: row.hintsUsed,
      rawScore: row.rawScore,
      weeklyPoints: weeklyPoints(index + 1),
      submittedAt: row.submittedAt
    }));

  return {
    puzzleId: targetPuzzleId,
    finalizedAt: new Date().toISOString(),
    scoring: {
      rawScore: "max(0, 1000 - elapsedSeconds * 1 - mistakes * 25 - hintsUsed * 50)",
      weeklyPoints: "1st 100, 2nd 90, 3rd 80, 4th 70, 5th 60, then minus 5 per rank to a floor of 25"
    },
    standings
  };
}

function buildSeasonStandings(weeks) {
  const totals = new Map();

  Object.values(weeks).forEach((weekRows) => {
    weekRows.forEach((row) => {
      const current = totals.get(row.playerId) || {
        playerId: row.playerId,
        displayName: row.displayName,
        totalPoints: 0,
        weeksPlayed: 0,
        wins: 0,
        rankTotal: 0
      };

      current.displayName = row.displayName;
      current.totalPoints += Number(row.weeklyPoints || 0);
      current.weeksPlayed += 1;
      current.wins += Number(row.rank) === 1 ? 1 : 0;
      current.rankTotal += Number(row.rank || 0);
      totals.set(row.playerId, current);
    });
  });

  return [...totals.values()]
    .map((row) => ({
      ...row,
      averageRank: row.weeksPlayed ? Number((row.rankTotal / row.weeksPlayed).toFixed(2)) : 0
    }))
    .sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.weeksPlayed !== a.weeksPlayed) return b.weeksPlayed - a.weeksPlayed;
      return a.displayName.localeCompare(b.displayName);
    })
    .map((row, index) => ({
      rank: index + 1,
      playerId: row.playerId,
      displayName: row.displayName,
      totalPoints: row.totalPoints,
      weeksPlayed: row.weeksPlayed,
      wins: row.wins,
      averageRank: row.averageRank
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

function calculateScore(elapsedMs, mistakes, hintsUsed = 0) {
  const elapsedSeconds = Math.floor(Number(elapsedMs || 0) / 1000);
  return Math.max(0, 1000 - elapsedSeconds * 1 - Number(mistakes || 0) * 25 - Number(hintsUsed || 0) * 50);
}

function weeklyPoints(rank) {
  if (rank === 1) return 100;
  if (rank === 2) return 90;
  if (rank === 3) return 80;
  if (rank === 4) return 70;
  if (rank === 5) return 60;
  return Math.max(25, 60 - (rank - 5) * 5);
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
