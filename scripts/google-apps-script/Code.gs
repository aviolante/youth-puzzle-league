const SHEET_NAMES = {
  players: "Players",
  runs: "Runs",
  submissions: "Submissions",
  config: "Config"
};

const HEADERS = {
  Config: ["key", "value"],
  Players: ["playerId", "displayName", "pin", "active", "admin"],
  Runs: ["runId", "puzzleId", "playerId", "displayName", "startedAt", "userAgent"],
  Submissions: [
    "submissionId",
    "runId",
    "puzzleId",
    "playerId",
    "displayName",
    "startedAt",
    "submittedAt",
    "elapsedMs",
    "mistakes",
    "hintsUsed",
    "rawScore",
    "completed",
    "duplicateOf"
  ]
};

function setup() {
  Object.keys(HEADERS).forEach(function (sheetName) {
    ensureSheet_(sheetName, HEADERS[sheetName]);
  });

  var players = getRows_(SHEET_NAMES.players);
  if (players.length === 0) {
    // Placeholder rows so the sheet has a shape to copy. Replace with real
    // players (and set admin = TRUE for whoever should see the preview tools).
    getSheet_(SHEET_NAMES.players).appendRow(["player1", "Player One", "0000", true, false]);
    getSheet_(SHEET_NAMES.players).appendRow(["player2", "Player Two", "0000", true, false]);
  }

  if (getRows_(SHEET_NAMES.config).length === 0) {
    // Blank join code = self-registration is closed. Put a code in the Config
    // tab to open sign-ups; change it there any time (no redeploy needed).
    getSheet_(SHEET_NAMES.config).appendRow(["joinCode", ""]);
  }

  if (!PropertiesService.getScriptProperties().getProperty("ADMIN_KEY")) {
    PropertiesService.getScriptProperties().setProperty("ADMIN_KEY", Utilities.getUuid());
  }
}

function showAdminKey() {
  setup();
  var adminKey = PropertiesService.getScriptProperties().getProperty("ADMIN_KEY");
  Logger.log("ADMIN_KEY: " + adminKey);
  return adminKey;
}

// Run this once from the Apps Script editor to wipe all recorded runs and
// submissions before going live. Headers and the Players roster are kept.
function clearRunsAndSubmissions() {
  setup();
  [SHEET_NAMES.runs, SHEET_NAMES.submissions].forEach(function (sheetName) {
    var sheet = getSheet_(sheetName);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.deleteRows(2, lastRow - 1); // keep the header row
    }
  });
  Logger.log("Cleared Runs and Submissions. Players roster left intact.");
}

function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};
  var callback = sanitizeCallback_(params.callback);

  try {
    setup();

    var action = params.action || "ping";
    var payload;

    if (action === "ping") {
      payload = { ok: true, now: iso_(new Date()) };
    } else if (action === "players") {
      payload = listPlayers_();
    } else if (action === "validate") {
      payload = validateSignIn_(params);
    } else if (action === "register") {
      payload = registerPlayer_(params);
    } else if (action === "start") {
      payload = startRun_(params, e);
    } else if (action === "submit") {
      payload = submitScore_(params);
    } else if (action === "export") {
      payload = exportSubmissions_(params);
    } else {
      payload = { ok: false, error: "Unknown action." };
    }

    return output_(payload, callback);
  } catch (error) {
    return output_({ ok: false, error: error.message || String(error) }, callback);
  }
}

// The roster is deliberately NOT public: players sign in by typing their own
// name, so nothing here needs a list of everyone playing. Kept as a valid
// action (rather than removed) so older cached clients get a clean response.
// The admin-key-gated export still returns the full roster for the finalizer.
function listPlayers_() {
  return { ok: true, players: [], rosterIsPrivate: true };
}

// Verify a player's PIN at sign-in without recording a run. Returns whether
// the player is an admin so the app can reveal preview tools immediately.
// Accepts either a typed displayName (current app) or a playerId (older
// clients that still had the roster dropdown).
function validateSignIn_(params) {
  var player = params.playerId
    ? validatePlayer_(params.playerId, params.pin)
    : validatePlayerByName_(params.displayName, params.pin);

  return {
    ok: true,
    playerId: player.playerId,
    displayName: player.displayName,
    isAdmin: String(player.admin).toLowerCase() === "true"
  };
}

// Self-service sign-up, gated by the shared join code in the Config tab. New
// players get an opaque playerId (never a name-derived one) and land active.
function registerPlayer_(params) {
  var displayName = requireParam_(params, "displayName").replace(/\s+/g, " ");
  var pin = requireParam_(params, "pin");
  var joinCode = requireParam_(params, "joinCode");

  if (displayName.length < 2 || displayName.length > 24) {
    throw new Error("Use a name between 2 and 24 characters.");
  }
  if (!/^[A-Za-z0-9 .'\-]+$/.test(displayName)) {
    throw new Error("Names can use letters, numbers, spaces, apostrophes, periods and hyphens.");
  }
  if (!/^\d{4}$/.test(pin)) {
    throw new Error("Choose a 4-digit PIN.");
  }

  var expected = getConfigValue_("joinCode");
  if (!expected) {
    throw new Error("Sign-ups are closed right now. Ask your leader to add you.");
  }
  if (normalizeName_(joinCode) !== normalizeName_(expected)) {
    throw new Error("That join code is not right.");
  }

  // Lock so two people can't claim the same name in the same moment. Season
  // totals key on display name, so a duplicate would silently merge scores.
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (findPlayerByName_(displayName)) {
      throw new Error("That name is taken. Try adding your last initial.");
    }

    var playerId = "p-" + Utilities.getUuid().slice(0, 8);
    var sheet = getSheet_(SHEET_NAMES.players);
    sheet.appendRow([playerId, displayName, "", true, false]);

    // Write the PIN as text so a leading zero (0000, 0123) survives.
    sheet.getRange(sheet.getLastRow(), 3).setNumberFormat("@").setValue(pin);

    return {
      ok: true,
      created: true,
      playerId: playerId,
      displayName: displayName,
      isAdmin: false
    };
  } finally {
    lock.releaseLock();
  }
}

function getConfigValue_(key) {
  var row = findRow_(SHEET_NAMES.config, function (candidate) {
    return String(candidate.key).trim().toLowerCase() === String(key).trim().toLowerCase();
  });
  return row ? String(row.value).trim() : "";
}

// Names are compared ignoring case, spacing and punctuation, so someone who
// registered as "Spencer B." can sign in by typing "spencer b". It also stops
// "Spencer B" and "Spencer B." registering as two players — season totals key
// on display name, so near-duplicates would split one player's score.
function normalizeName_(value) {
  return String(value === undefined || value === null ? "" : value)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

function findPlayerByName_(displayName) {
  var wanted = normalizeName_(displayName);
  return findRow_(SHEET_NAMES.players, function (row) {
    return normalizeName_(row.displayName) === wanted;
  });
}

function startRun_(params, event) {
  var player = validatePlayer_(params.playerId, params.pin);
  var puzzleId = requireParam_(params, "puzzleId");
  var now = new Date();
  var runId = Utilities.getUuid();
  var userAgent = "";

  if (event && event.parameter && event.parameter.userAgent) {
    userAgent = event.parameter.userAgent;
  }

  getSheet_(SHEET_NAMES.runs).appendRow([
    runId,
    puzzleId,
    player.playerId,
    player.displayName,
    iso_(now),
    userAgent
  ]);

  return {
    ok: true,
    runId: runId,
    puzzleId: puzzleId,
    playerId: player.playerId,
    displayName: player.displayName,
    startedAt: iso_(now),
    isAdmin: String(player.admin).toLowerCase() === "true"
  };
}

function submitScore_(params) {
  var player = validatePlayer_(params.playerId, params.pin);
  var puzzleId = requireParam_(params, "puzzleId");
  var runId = requireParam_(params, "runId");
  var run = findRow_(SHEET_NAMES.runs, function (row) {
    return row.runId === runId && row.playerId === player.playerId && row.puzzleId === puzzleId;
  });

  if (!run) {
    throw new Error("This run was not found. Start the puzzle again.");
  }

  var existing = findRow_(SHEET_NAMES.submissions, function (row) {
    return row.playerId === player.playerId && row.puzzleId === puzzleId && String(row.completed).toLowerCase() === "true" && !row.duplicateOf;
  });

  if (existing) {
    return {
      ok: true,
      duplicate: true,
      submissionId: existing.submissionId,
      elapsedMs: Number(existing.elapsedMs),
      rawScore: Number(existing.rawScore),
      submittedAt: existing.submittedAt
    };
  }

  var startedAt = new Date(run.startedAt);
  var submittedAt = new Date();
  var elapsedMs = Math.max(0, submittedAt.getTime() - startedAt.getTime());
  var mistakes = clampNumber_(params.mistakes, 0, 99);
  var hintsUsed = clampNumber_(params.hintsUsed || 0, 0, 99);
  var rawScore = calculateScore_(elapsedMs, mistakes, hintsUsed);
  var submissionId = Utilities.getUuid();

  getSheet_(SHEET_NAMES.submissions).appendRow([
    submissionId,
    runId,
    puzzleId,
    player.playerId,
    player.displayName,
    iso_(startedAt),
    iso_(submittedAt),
    elapsedMs,
    mistakes,
    hintsUsed,
    rawScore,
    true,
    ""
  ]);

  return {
    ok: true,
    submissionId: submissionId,
    elapsedMs: elapsedMs,
    rawScore: rawScore,
    submittedAt: iso_(submittedAt)
  };
}

function exportSubmissions_(params) {
  var adminKey = PropertiesService.getScriptProperties().getProperty("ADMIN_KEY");
  if (!adminKey || params.adminKey !== adminKey) {
    throw new Error("Invalid admin key.");
  }

  // Map of which players are admins, so the finalizer can exclude their scores.
  var adminIds = {};
  getRows_(SHEET_NAMES.players).forEach(function (player) {
    if (String(player.admin).toLowerCase() === "true") adminIds[player.playerId] = true;
  });

  var puzzleId = params.puzzleId || "";
  var submissions = getRows_(SHEET_NAMES.submissions)
    .filter(function (row) {
      return !puzzleId || row.puzzleId === puzzleId;
    })
    .map(function (row) {
      return {
        submissionId: row.submissionId,
        runId: row.runId,
        puzzleId: row.puzzleId,
        playerId: row.playerId,
        displayName: row.displayName,
        startedAt: row.startedAt,
        submittedAt: row.submittedAt,
        elapsedMs: Number(row.elapsedMs),
        mistakes: Number(row.mistakes),
        hintsUsed: Number(row.hintsUsed || 0),
        rawScore: Number(row.rawScore),
        completed: String(row.completed).toLowerCase() === "true",
        duplicateOf: row.duplicateOf || "",
        admin: !!adminIds[row.playerId]
      };
    });

  // Runs (every game START — the clock begins on the player's first move). A run
  // with no matching submission means the player attempted the puzzle but did not
  // finish; the finalizer floors those at the participation score.
  var runs = getRows_(SHEET_NAMES.runs)
    .filter(function (row) {
      return !puzzleId || row.puzzleId === puzzleId;
    })
    .map(function (row) {
      return {
        runId: row.runId,
        puzzleId: row.puzzleId,
        playerId: row.playerId,
        displayName: row.displayName,
        startedAt: row.startedAt
      };
    });

  // Full active roster (with admin flag) so the finalizer can list every player
  // and exclude admins even when they did not submit. Admin-key gated, so the
  // admin flag stays private.
  var roster = getRows_(SHEET_NAMES.players)
    .filter(function (row) {
      return String(row.active).toLowerCase() !== "false";
    })
    .map(function (row) {
      return {
        playerId: row.playerId,
        displayName: row.displayName,
        admin: String(row.admin).toLowerCase() === "true"
      };
    });

  return {
    ok: true,
    puzzleId: puzzleId,
    submissions: submissions,
    runs: runs,
    roster: roster
  };
}

function validatePlayer_(playerId, pin) {
  playerId = requireParam_({ playerId: playerId }, "playerId");
  pin = requireParam_({ pin: pin }, "pin");

  var player = findRow_(SHEET_NAMES.players, function (row) {
    return row.playerId === playerId;
  });

  return checkPlayerPin_(player, pin);
}

function validatePlayerByName_(displayName, pin) {
  displayName = requireParam_({ displayName: displayName }, "displayName");
  pin = requireParam_({ pin: pin }, "pin");

  return checkPlayerPin_(findPlayerByName_(displayName), pin);
}

function checkPlayerPin_(player, pin) {
  if (!player || String(player.active).toLowerCase() === "false") {
    throw new Error("Player is not active.");
  }

  if (!pinsMatch_(player.pin, pin)) {
    throw new Error("The PIN does not match that player.");
  }

  return player;
}

// A PIN typed as "0123" comes back from the sheet as the number 123 when the
// cell was never formatted as text, so compare zero-padded as well.
function pinsMatch_(stored, given) {
  var a = String(stored).trim();
  var b = String(given).trim();
  if (a === b) return true;
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
  while (a.length < 4) a = "0" + a;
  while (b.length < 4) b = "0" + b;
  return a === b;
}

function calculateScore_(elapsedMs, mistakes, hintsUsed) {
  var elapsedSeconds = Math.floor(Number(elapsedMs || 0) / 1000);
  return Math.max(0, 1000 - elapsedSeconds * 1 - Number(mistakes || 0) * 25 - Number(hintsUsed || 0) * 50);
}

function getSheet_(sheetName) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
}

function ensureSheet_(sheetName, headers) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var hasHeaders = current.some(function (cell) {
    return cell !== "";
  });

  if (!hasHeaders) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
}

function getRows_(sheetName) {
  var sheet = getSheet_(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var values = sheet.getDataRange().getValues();
  var headers = values.shift();

  return values.map(function (row, rowIndex) {
    var object = { _row: rowIndex + 2 };
    headers.forEach(function (header, index) {
      object[header] = row[index];
    });
    return object;
  });
}

function findRow_(sheetName, predicate) {
  var rows = getRows_(sheetName);
  for (var index = 0; index < rows.length; index += 1) {
    if (predicate(rows[index])) return rows[index];
  }
  return null;
}

function requireParam_(params, key) {
  var value = params[key];
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error("Missing " + key + ".");
  }
  return String(value).trim();
}

function clampNumber_(value, min, max) {
  var number = Number(value);
  if (!isFinite(number)) number = min;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function iso_(date) {
  return Utilities.formatDate(date, "UTC", "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

function sanitizeCallback_(callback) {
  if (!callback) return "";
  if (/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) return callback;
  return "";
}

function output_(payload, callback) {
  var text = callback ? callback + "(" + JSON.stringify(payload) + ");" : JSON.stringify(payload);
  var mimeType = callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON;
  return ContentService.createTextOutput(text).setMimeType(mimeType);
}
