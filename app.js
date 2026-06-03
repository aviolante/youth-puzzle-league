const config = window.PQ_CONFIG || {};
let connectionsController = null;
let strandsController = null;
let weekContext = null;
const gamesPresent = { c: false, s: false };
const gamesSolved = { c: false, s: false };

init().catch((error) => {
  console.error(error);
});

async function init() {
  const current = await loadJson("data/current.json");
  const connectionsId = current.puzzleId;
  const strandsId = current.strandsPuzzleId;

  const [fallbackPlayers, connectionsPuzzle, strandsPuzzle, context, season, weekly] = await Promise.all([
    loadJson("data/players.json"),
    connectionsId ? loadJson(`data/puzzles/${connectionsId}.json`) : Promise.resolve(null),
    strandsId ? loadOptionalJson(`data/puzzles/${strandsId}.json`, null) : Promise.resolve(null),
    current.contextId ? loadOptionalJson(`data/context/${current.contextId}.json`, null) : Promise.resolve(null),
    loadOptionalJson("data/leaderboards/season.json", { weeks: {}, standings: [] }),
    loadOptionalJson(`data/leaderboards/${connectionsId}.json`, { puzzleId: connectionsId, standings: [] })
  ]);

  const players = await loadPlayers(fallbackPlayers.players || []);

  document.querySelector("#app-title").textContent = config.groupName || "Youth Puzzle League";

  bindTabs(strandsPuzzle);

  if (connectionsPuzzle) {
    connectionsController = new GameController({
      prefix: "c",
      puzzle: connectionsPuzzle,
      players,
      context,
      adapter: new ConnectionsBoard(connectionsPuzzle)
    });
    connectionsController.init();
  }

  if (strandsPuzzle) {
    strandsController = new GameController({
      prefix: "s",
      puzzle: strandsPuzzle,
      players,
      context,
      adapter: new StrandsBoard(strandsPuzzle)
    });
    strandsController.init();
  }

  weekContext = context;
  gamesPresent.c = Boolean(connectionsPuzzle);
  gamesPresent.s = Boolean(strandsPuzzle);
  renderReading();

  renderLeaderboards(weekly, season);

  setupAdmin();
}

// "This Week" tab: locked until every game present is solved, then it shows the
// reading insights (summary, who's who, places, background).
function markGameSolved(prefix) {
  gamesSolved[prefix] = true;
  renderReading();
  if (isWeekComplete()) {
    document.querySelector('[data-view-target="reading"]')?.classList.add("is-ready");
  }
}

function isWeekComplete() {
  const games = ["c", "s"].filter((key) => gamesPresent[key]);
  return games.length > 0 && games.every((key) => gamesSolved[key]);
}

function renderReading() {
  const el = document.querySelector("#reading-panel");
  if (!el) return;
  const ctx = weekContext;

  const heading = `
    ${ctx?.dateLabel ? `<p class="eyebrow">${escapeHtml(ctx.dateLabel)}</p>` : ""}
    <h2 id="reading-week-heading">${lessonTitleHtml(ctx, "This Week's Reading")}</h2>
    ${ctx?.reference ? `<p class="reading-ref">${escapeHtml(ctx.reference)}</p>` : ""}`;

  if (!ctx) {
    el.innerHTML = `${heading}<p class="support-text">No reading notes for this week yet.</p>`;
    return;
  }

  if (!isWeekComplete()) {
    const checklist = ["c", "s"]
      .filter((key) => gamesPresent[key])
      .map((key) => {
        const name = key === "c" ? "Connections" : "Strands";
        const done = gamesSolved[key];
        return `<li class="${done ? "is-done" : ""}">${done ? "✓" : "○"} ${name} — ${done ? "solved" : "not finished"}</li>`;
      })
      .join("");
    el.innerHTML = `
      ${heading}
      <div class="reading-locked">
        <p class="reading-lock-note">🔒 Solve both puzzles to unlock this week's reading insights.</p>
        <ul class="reading-checklist">${checklist}</ul>
      </div>`;
    return;
  }

  el.innerHTML = `${heading}${renderContextBody(ctx)}`;
}

// Lesson titles read like Come Follow Me headings: quoted and italicized.
function lessonTitleHtml(ctx, fallback) {
  if (ctx?.lessonTitle) return `<em class="lesson-quote">&ldquo;${escapeHtml(ctx.lessonTitle)}&rdquo;</em>`;
  return escapeHtml(fallback || "");
}

function renderContextBody(ctx) {
  const people = (ctx.people || [])
    .map((p) => `<li><strong>${escapeHtml(p.name)}</strong> — ${escapeHtml(p.note)}</li>`)
    .join("");
  const places = (ctx.locations || [])
    .map((p) => `<li><strong>${escapeHtml(p.name)}</strong> — ${escapeHtml(p.note)}</li>`)
    .join("");
  return `
    ${ctx.summary ? `<p class="context-summary">${escapeHtml(ctx.summary)}</p>` : ""}
    ${people ? `<h4>Who's who</h4><ul class="context-list">${people}</ul>` : ""}
    ${places ? `<h4>Places</h4><ul class="context-list">${places}</ul>` : ""}
    ${ctx.background ? `<h4>Background</h4><p>${escapeHtml(ctx.background)}</p>` : ""}`;
}

// Admin/preview mode for building: add ?admin=1 to the URL for a toolbar that
// fills either board with the solution and shows the post-completion context
// (no run, no score submitted). ?preview=connections|strands auto-runs one on
// load, which also makes it easy to screenshot a finished state.
function setupAdmin() {
  const params = new URLSearchParams(location.search);
  const preview = params.get("preview");
  if (preview === "connections" && connectionsController) {
    switchView("connections");
    connectionsController.adminPreview();
  } else if (preview === "strands" && strandsController) {
    switchView("strands");
    strandsController.adminPreview();
  } else if (preview === "all" || preview === "both") {
    connectionsController?.adminPreview();
    strandsController?.adminPreview();
    switchView("reading");
  }

  // ?view=<tab> opens a tab on load without solving anything.
  const view = params.get("view");
  if (view) switchView(view);

  if (params.has("admin") || preview || view) showAdminBar();
}

// Build the floating admin toolbar (idempotent). Triggered by the ?admin=1 URL
// or by an admin player signing in with a valid PIN.
function showAdminBar() {
  if (document.querySelector(".admin-bar")) return;

  const bar = document.createElement("div");
  bar.className = "admin-bar";
  bar.innerHTML = `
    <span class="admin-bar__label">Admin</span>
    ${connectionsController ? '<button type="button" data-admin="connections">Solve Connections</button>' : ""}
    ${strandsController ? '<button type="button" data-admin="strands">Solve Strands</button>' : ""}
    <button type="button" data-admin="reset">Reset</button>`;
  document.body.appendChild(bar);

  bar.addEventListener("click", (event) => {
    const action = event.target.dataset?.admin;
    if (action === "connections") {
      switchView("connections");
      connectionsController.adminPreview();
    } else if (action === "strands") {
      switchView("strands");
      strandsController.adminPreview();
    } else if (action === "reset") {
      location.reload();
    }
  });
}

function bindTabs(strandsPuzzle) {
  const tabs = document.querySelectorAll("[data-view-target]");
  if (!strandsPuzzle) {
    document.querySelector('[data-view-target="strands"]')?.remove();
    document.querySelector("#strands-view")?.remove();
  }
  tabs.forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.viewTarget));
  });
}

function switchView(target) {
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("is-active"));
  document.querySelector(`#${target}-view`)?.classList.add("is-active");
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.viewTarget === target);
  });

  // The Strands board has no size while hidden, so connector lines can't be
  // measured. Redraw once it becomes visible.
  if (target === "strands" && strandsController) strandsController.adapter.render();
}

// ---------------------------------------------------------------------------
// Shared game shell: player form, official run, timer, scoring, submission.
// Board-specific behavior lives in the adapter it is given.
// ---------------------------------------------------------------------------

class GameController {
  constructor({ prefix, puzzle, players, context, adapter }) {
    this.prefix = prefix;
    this.puzzle = puzzle;
    this.players = players;
    this.context = context;
    this.adapter = adapter;
    this.adapter.controller = this;

    this.started = false;
    this.completed = false;
    this.submitting = false;
    this.player = null;
    this.pin = "";
    this.runId = "";
    this.startedAt = 0;
    this.timerHandle = null;

    const id = (suffix) => document.querySelector(`#${prefix}-${suffix}`);
    this.els = {
      heading: id("game-heading"),
      summary: id("puzzle-summary"),
      idLabel: id("puzzle-id-label"),
      title: id("puzzle-title"),
      readingRef: id("reading-ref"),
      deadline: id("deadline-label"),
      form: id("player-form"),
      select: id("player-select"),
      pin: id("pin-input"),
      start: id("start-button"),
      status: id("submission-status"),
      timer: id("timer-value"),
      mistakes: id("mistake-value"),
      hints: id("hint-value"),
      score: id("score-value")
    };
  }

  init() {
    this.renderHeader();
    this.renderPlayers();
    this.adapter.render();
    this.els.form.addEventListener("submit", (event) => this.start(event));
    this.setControls();
    this.updateMetrics();
  }

  renderHeader() {
    const ctx = this.context;
    const gameLabel = this.puzzle.type === "strands" ? "Strands" : "Connections";

    // Mimic the Come Follow Me weekly heading: dates, lesson title, scriptures.
    this.els.idLabel.textContent = ctx?.dateLabel ? `${ctx.dateLabel} · ${gameLabel}` : gameLabel;
    this.els.title.innerHTML = lessonTitleHtml(ctx, this.puzzle.title);
    if (this.els.readingRef) this.els.readingRef.textContent = ctx?.reference || "";

    // Player panel: which game + how to play.
    this.els.heading.textContent = gameLabel;
    this.els.summary.textContent = this.puzzle.instructions || "";
    this.els.deadline.textContent = formatDeadline(this.puzzle.closesAt);
  }

  renderPlayers() {
    this.els.select.querySelectorAll("option:not([value=''])").forEach((option) => option.remove());
    const options = this.players
      .filter((player) => player.active !== false)
      .map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(player.displayName)}</option>`);
    this.els.select.insertAdjacentHTML("beforeend", options.join(""));
  }

  async start(event) {
    event.preventDefault();
    const player = this.players.find((candidate) => candidate.id === this.els.select.value);
    const pin = this.els.pin.value.trim();
    if (!player || !pin) {
      this.setStatus("Choose your name and enter your PIN before starting.", "error");
      return;
    }

    this.setStatus("Starting your official run...");
    this.els.start.disabled = true;

    try {
      const response = await scoreClient.start({
        puzzleId: this.puzzle.id,
        playerId: player.id,
        pin,
        displayName: player.displayName
      });
      if (!response.ok) throw new Error(response.error || "The score sheet rejected this start request.");

      this.player = player;
      this.pin = pin;
      this.runId = response.runId;
      this.startedAt = response.startedAt ? new Date(response.startedAt).getTime() : Date.now();
      this.started = true;
      this.completed = false;
      this.timerHandle = window.setInterval(() => this.updateMetrics(), 250);

      this.els.select.disabled = true;
      this.els.pin.disabled = true;
      this.setStatus(
        response.local
          ? "Practice mode started. Add a Google Script URL to submit official scores."
          : "Official run started. Finish the board to submit your score.",
        response.local ? "" : "success"
      );

      // Admin (per the Players-tab `admin` flag, verified server-side): reveal
      // the preview tools.
      if (response.isAdmin) {
        showAdminBar();
        this.setStatus("Admin signed in — preview tools are available at the bottom of the screen.", "success");
      }
      this.adapter.render();
      this.setControls();
      this.updateMetrics();
    } catch (error) {
      console.error(error);
      this.els.start.disabled = false;
      this.setStatus(error.message, "error");
    }
  }

  // Called by the adapter whenever the board changes.
  onProgress() {
    this.updateMetrics();
    this.setControls();
    if (!this.completed && this.adapter.isComplete()) this.complete();
  }

  async complete() {
    this.completed = true;
    window.clearInterval(this.timerHandle);
    this.updateMetrics();
    this.setControls();
    markGameSolved(this.prefix);
    await this.submit();
  }

  // Admin/preview: fill the board with the solution, with no official run and no
  // score submitted. For building and screenshots only.
  adminPreview() {
    this.adapter.revealAll();
    this.completed = true;
    window.clearInterval(this.timerHandle);
    this.setControls();
    markGameSolved(this.prefix);
    this.setStatus("Admin preview — solution shown. No score recorded.", "success");
  }

  async submit() {
    if (this.submitting) return;
    this.submitting = true;
    this.setStatus("Puzzle solved. Submitting your score...");
    try {
      const response = await scoreClient.submit({
        runId: this.runId,
        puzzleId: this.puzzle.id,
        playerId: this.player.id,
        pin: this.pin,
        mistakes: this.adapter.mistakes,
        hintsUsed: this.adapter.hintsUsed,
        displayName: this.player.displayName,
        startedAt: this.startedAt
      });
      if (!response.ok) throw new Error(response.error || "The score could not be submitted.");

      const elapsedMs = response.elapsedMs || Date.now() - this.startedAt;
      const rawScore = response.rawScore ?? calculateScore(elapsedMs, this.adapter.mistakes, this.adapter.hintsUsed);
      const duplicateText = response.duplicate ? " Your first official score was already recorded." : "";
      this.setStatus(
        `Score submitted for ${this.player.displayName}: ${formatTime(elapsedMs)}, ${this.adapter.mistakes} mistakes, ${rawScore} points.${duplicateText}`,
        "success"
      );
    } catch (error) {
      console.error(error);
      this.setStatus(`Your puzzle is solved, but the score did not submit: ${error.message}`, "error");
    } finally {
      this.submitting = false;
    }
  }

  get canPlay() {
    return this.started && !this.completed;
  }

  setControls() {
    this.adapter.setControls();
  }

  updateMetrics() {
    const elapsedMs = this.startedAt ? Math.max(0, Date.now() - this.startedAt) : 0;
    this.els.timer.textContent = formatTime(elapsedMs);
    this.els.mistakes.textContent = String(this.adapter.mistakes);
    if (this.els.hints) this.els.hints.textContent = String(this.adapter.hintsUsed);
    this.els.score.textContent = String(calculateScore(elapsedMs, this.adapter.mistakes, this.adapter.hintsUsed));
  }

  setStatus(message, tone = "") {
    this.els.status.textContent = message;
    this.els.status.classList.toggle("is-error", tone === "error");
    this.els.status.classList.toggle("is-success", tone === "success");
  }
}

// ---------------------------------------------------------------------------
// Connections board adapter
// ---------------------------------------------------------------------------

class ConnectionsBoard {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.mistakes = 0;
    this.hintsUsed = 0;
    this.selectedIds = new Set();
    this.solvedCategoryIds = new Set();
    this.tiles = shuffle(
      puzzle.categories.flatMap((category) =>
        category.items.map((label, index) => ({ id: `${category.id}-${index}`, categoryId: category.id, label }))
      )
    );

    this.grid = document.querySelector("#c-tile-grid");
    this.solved = document.querySelector("#c-solved-groups");
    this.checkButton = document.querySelector("#c-check-button");
    this.shuffleButton = document.querySelector("#c-shuffle-button");
    this.clearButton = document.querySelector("#c-clear-button");

    this.checkButton.addEventListener("click", () => this.check());
    this.shuffleButton.addEventListener("click", () => this.shuffleTiles());
    this.clearButton.addEventListener("click", () => {
      this.selectedIds.clear();
      this.render();
      this.controller.onProgress();
    });
  }

  isComplete() {
    return this.solvedCategoryIds.size === this.puzzle.categories.length;
  }

  revealAll() {
    this.puzzle.categories.forEach((category) => this.solvedCategoryIds.add(category.id));
    this.selectedIds.clear();
    this.render();
  }

  render(wrongIds = []) {
    const wrongSet = new Set(wrongIds);
    const unsolved = this.tiles.filter((tile) => !this.solvedCategoryIds.has(tile.categoryId));
    const solvedCategories = this.puzzle.categories.filter((category) => this.solvedCategoryIds.has(category.id));

    this.solved.innerHTML = solvedCategories
      .map(
        (category) => `
          <article class="solved-group">
            <h3>${escapeHtml(category.title)}</h3>
            <p>${escapeHtml(category.items.join(", "))}</p>
          </article>`
      )
      .join("");

    this.grid.innerHTML = unsolved
      .map((tile) => {
        const classes = [
          "tile-button",
          this.selectedIds.has(tile.id) ? "is-selected" : "",
          wrongSet.has(tile.id) ? "is-wrong" : ""
        ]
          .filter(Boolean)
          .join(" ");
        return `<button class="${classes}" type="button" data-tile-id="${escapeHtml(tile.id)}">${escapeHtml(tile.label)}</button>`;
      })
      .join("");

    this.grid.querySelectorAll("[data-tile-id]").forEach((button) => {
      button.addEventListener("click", () => this.toggle(button.dataset.tileId));
    });
  }

  toggle(tileId) {
    if (!this.controller.canPlay) {
      this.controller.setStatus("Start the puzzle before selecting tiles.", "error");
      return;
    }
    if (this.selectedIds.has(tileId)) {
      this.selectedIds.delete(tileId);
    } else if (this.selectedIds.size < 4) {
      this.selectedIds.add(tileId);
    }
    this.render();
    this.controller.onProgress();
  }

  check() {
    if (this.selectedIds.size !== 4) return;
    const selected = this.tiles.filter((tile) => this.selectedIds.has(tile.id));
    const categoryIds = new Set(selected.map((tile) => tile.categoryId));

    if (categoryIds.size === 1) {
      const [categoryId] = [...categoryIds];
      this.solvedCategoryIds.add(categoryId);
      this.selectedIds.clear();
      const category = this.puzzle.categories.find((candidate) => candidate.id === categoryId);
      this.controller.setStatus(`Correct group: ${category.title}.`, "success");
      this.render();
      this.controller.onProgress();
    } else {
      this.mistakes += 1;
      const wrongIds = [...this.selectedIds];
      // "One away" only when exactly three of the four share a single group.
      const counts = {};
      selected.forEach((tile) => (counts[tile.categoryId] = (counts[tile.categoryId] || 0) + 1));
      const closest = Math.max(...Object.values(counts));
      this.controller.setStatus(
        closest === 3 ? "So close — one away!" : "That group does not match. Try another set.",
        "error"
      );
      this.render(wrongIds);
      window.setTimeout(() => this.render(), 420);
      this.controller.onProgress();
    }
  }

  shuffleTiles() {
    const solved = [];
    const unsolved = [];
    this.tiles.forEach((tile) => {
      (this.solvedCategoryIds.has(tile.categoryId) ? solved : unsolved).push(tile);
    });
    this.tiles = [...solved, ...shuffle(unsolved)];
    this.selectedIds.clear();
    this.render();
    this.controller.onProgress();
  }

  setControls() {
    const canPlay = this.controller.canPlay;
    this.checkButton.disabled = !canPlay || this.selectedIds.size !== 4;
    this.shuffleButton.disabled = !canPlay;
    this.clearButton.disabled = !canPlay || this.selectedIds.size === 0;
  }
}

// ---------------------------------------------------------------------------
// Strands board adapter
// ---------------------------------------------------------------------------

class StrandsBoard {
  constructor(puzzle) {
    this.puzzle = puzzle;
    this.cols = puzzle.cols;
    this.rows = puzzle.rows;
    this.mistakes = 0;
    this.hintsUsed = 0;
    this.path = []; // cell indices of the current selection
    this.foundWords = new Set(); // matched words
    this.foundCells = new Map(); // cell -> "theme" | "spangram"
    this.revealedCells = new Set(); // hint-revealed cells

    // Lookup: sorted-cell-key -> { word, kind }
    this.byCells = new Map();
    const register = (entry, kind) => {
      this.byCells.set([...entry.cells].sort((a, b) => a - b).join(","), { word: entry.word, kind, cells: entry.cells });
    };
    register(puzzle.spangram, "spangram");
    puzzle.themeWords.forEach((entry) => register(entry, "theme"));
    this.totalWords = puzzle.themeWords.length + 1;

    this.theme = document.querySelector("#s-theme");
    this.progress = document.querySelector("#s-progress");
    this.gridEl = document.querySelector("#s-grid");
    this.linksEl = document.querySelector("#s-links");
    this.foundEl = document.querySelector("#s-found");

    // Redraw connector lines when the board is resized (cell sizes change).
    window.addEventListener("resize", () => this.drawLinks());
    this.checkButton = document.querySelector("#s-check-button");
    this.hintButton = document.querySelector("#s-hint-button");
    this.clearButton = document.querySelector("#s-clear-button");

    this.checkButton.addEventListener("click", () => this.check());
    this.hintButton.addEventListener("click", () => this.hint());
    this.clearButton.addEventListener("click", () => {
      this.path = [];
      this.render();
      this.controller.onProgress();
    });
  }

  isComplete() {
    return this.foundWords.size === this.totalWords;
  }

  revealAll() {
    [{ entry: this.puzzle.spangram, kind: "spangram" }, ...this.puzzle.themeWords.map((entry) => ({ entry, kind: "theme" }))].forEach(
      ({ entry, kind }) => {
        this.foundWords.add(entry.word);
        entry.cells.forEach((cell) => this.foundCells.set(cell, kind));
      }
    );
    this.path = [];
    this.render();
  }

  render() {
    this.theme.textContent = this.puzzle.theme ? `Theme: ${this.puzzle.theme}` : "";
    this.progress.textContent = `${this.foundWords.size} of ${this.totalWords} found`;
    this.gridEl.style.setProperty("--cols", this.cols);

    const pathSet = new Set(this.path);
    const last = this.path[this.path.length - 1];

    this.gridEl.innerHTML = this.puzzle.grid
      .map((letter, cell) => {
        const found = this.foundCells.get(cell);
        const classes = [
          "strands-cell",
          pathSet.has(cell) ? "is-active" : "",
          cell === last ? "is-head" : "",
          found === "theme" ? "is-theme" : "",
          found === "spangram" ? "is-spangram" : "",
          this.revealedCells.has(cell) ? "is-hint" : ""
        ]
          .filter(Boolean)
          .join(" ");
        return `<button class="${classes}" type="button" data-cell="${cell}">${escapeHtml(letter)}</button>`;
      })
      .join("");

    this.gridEl.querySelectorAll("[data-cell]").forEach((button) => {
      button.addEventListener("click", () => this.tap(Number(button.dataset.cell)));
    });

    this.drawLinks();

    this.foundEl.innerHTML = [...this.foundWords]
      .map((word) => {
        const isSpangram = word === this.puzzle.spangram.word;
        return `<span class="found-chip${isSpangram ? " found-chip--spangram" : ""}">${escapeHtml(word)}</span>`;
      })
      .join("");
  }

  // Draw the capsule connector lines through each word's cells. The SVG sits
  // behind the letter circles, so the lines only show in the gaps between them.
  drawLinks() {
    const cells = [...this.gridEl.querySelectorAll("[data-cell]")];
    const width = this.gridEl.offsetWidth;
    const height = this.gridEl.offsetHeight;
    if (!width || !height || !cells.length) {
      this.linksEl.innerHTML = "";
      return;
    }
    this.linksEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const stroke = cells[0].offsetWidth * 0.42;
    const center = (cell) => ({
      x: cells[cell].offsetLeft + cells[cell].offsetWidth / 2,
      y: cells[cell].offsetTop + cells[cell].offsetHeight / 2
    });
    const polyline = (cellList, color) => {
      if (cellList.length < 2) return "";
      const points = cellList.map((cell) => `${center(cell).x},${center(cell).y}`).join(" ");
      return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" />`;
    };

    const segments = [];
    for (const entry of [this.puzzle.spangram, ...this.puzzle.themeWords]) {
      if (!this.foundWords.has(entry.word)) continue;
      const color = entry === this.puzzle.spangram ? "#dbbf6b" : "#49cce6";
      segments.push(polyline(entry.cells, color));
    }
    segments.push(polyline(this.path, "#007da5")); // active trace on top
    this.linksEl.innerHTML = segments.join("");
  }

  tap(cell) {
    if (!this.controller.canPlay) {
      this.controller.setStatus("Start the puzzle before tracing letters.", "error");
      return;
    }
    if (this.foundCells.has(cell)) return; // already part of a solved word

    const index = this.path.indexOf(cell);
    if (index !== -1) {
      // Tap a cell already in the path: trim back to it (or remove if it is the head).
      this.path = this.path.slice(0, index + (cell === this.path[this.path.length - 1] ? 0 : 1));
      this.render();
      this.controller.onProgress();
      return;
    }

    if (this.path.length === 0 || this.isAdjacent(this.path[this.path.length - 1], cell)) {
      this.path.push(cell);
    } else {
      this.controller.setStatus("Letters must connect to the last one you picked.", "error");
      return;
    }
    this.render();
    this.controller.onProgress();
  }

  check() {
    if (this.path.length < 3) return;
    const key = [...this.path].sort((a, b) => a - b).join(",");
    const match = this.byCells.get(key);

    if (match && !this.foundWords.has(match.word)) {
      this.foundWords.add(match.word);
      match.cells.forEach((cell) => this.foundCells.set(cell, match.kind));
      this.path = [];
      this.controller.setStatus(
        match.kind === "spangram" ? `Spangram found: ${match.word}!` : `Theme word found: ${match.word}.`,
        "success"
      );
      this.render();
      this.controller.onProgress();
    } else {
      this.mistakes += 1;
      this.controller.setStatus("That is not one of this week's words. Try another path.", "error");
      this.gridEl.classList.add("is-wrong");
      window.setTimeout(() => {
        this.gridEl.classList.remove("is-wrong");
        this.path = [];
        this.render();
        this.controller.onProgress();
      }, 420);
    }
  }

  hint() {
    if (!this.controller.canPlay) return;
    // Reveal one not-yet-found cell from the shortest unsolved word.
    const unsolved = [this.puzzle.spangram, ...this.puzzle.themeWords]
      .filter((entry) => !this.foundWords.has(entry.word))
      .sort((a, b) => a.word.length - b.word.length);
    if (!unsolved.length) return;
    const target = unsolved[0];
    const cell = target.cells.find((c) => !this.revealedCells.has(c) && !this.foundCells.has(c));
    if (cell === undefined) return;

    this.revealedCells.add(cell);
    this.hintsUsed += 1;
    this.controller.setStatus("Revealed a letter from one of the words.", "");
    this.render();
    this.controller.onProgress();
  }

  isAdjacent(a, b) {
    const ar = Math.floor(a / this.cols);
    const ac = a % this.cols;
    const br = Math.floor(b / this.cols);
    const bc = b % this.cols;
    return Math.abs(ar - br) <= 1 && Math.abs(ac - bc) <= 1 && a !== b;
  }

  setControls() {
    const canPlay = this.controller.canPlay;
    this.checkButton.disabled = !canPlay || this.path.length < 3;
    this.hintButton.disabled = !canPlay || this.isComplete();
    this.clearButton.disabled = !canPlay || this.path.length === 0;
  }
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

function renderLeaderboards(weekly, season) {
  const weeklyBody = document.querySelector("#weekly-leaderboard-body");
  const seasonBody = document.querySelector("#season-leaderboard-body");
  document.querySelector("#weekly-finalized-label").textContent = weekly.finalizedAt
    ? `Finalized ${formatShortDate(weekly.finalizedAt)}`
    : "Not finalized";

  weeklyBody.innerHTML = weekly.standings?.length
    ? weekly.standings
        .map(
          (row) => `
            <tr>
              <td>${row.rank}</td>
              <td>${escapeHtml(row.displayName)}</td>
              <td>${escapeHtml(row.formattedTime || formatTime(row.elapsedMs))}</td>
              <td>${row.mistakes}</td>
              <td>${row.rawScore}</td>
              <td>${row.weeklyPoints}</td>
            </tr>`
        )
        .join("")
    : `<tr><td colspan="6">No weekly results yet.</td></tr>`;

  const weekCount = season.weeks ? Object.keys(season.weeks).length : 0;
  document.querySelector("#season-count-label").textContent = `${weekCount} ${weekCount === 1 ? "week" : "weeks"}`;
  seasonBody.innerHTML = season.standings?.length
    ? season.standings
        .map(
          (row) => `
            <tr>
              <td>${row.rank}</td>
              <td>${escapeHtml(row.displayName)}</td>
              <td>${row.totalPoints}</td>
              <td>${row.weeksPlayed}</td>
              <td>${row.wins}</td>
            </tr>`
        )
        .join("")
    : `<tr><td colspan="5">No season results yet.</td></tr>`;
}

// ---------------------------------------------------------------------------
// Scoring + data helpers
// ---------------------------------------------------------------------------

function calculateScore(elapsedMs, mistakes, hintsUsed = 0) {
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  return Math.max(0, 1000 - elapsedSeconds * 1 - mistakes * 25 - hintsUsed * 50);
}

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDeadline(value) {
  if (!value) return "No deadline set";
  const date = new Date(value);
  return `Closes ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function formatShortDate(value) {
  const date = new Date(value);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return response.json();
}

async function loadOptionalJson(path, fallback) {
  try {
    return await loadJson(path);
  } catch {
    return fallback;
  }
}

async function loadPlayers(fallbackPlayers) {
  if (!config.googleScriptUrl) return fallbackPlayers;
  try {
    const response = await callGoogleScript({ action: "players" });
    if (!response.ok) throw new Error(response.error || "Could not load Google Sheet players.");
    return (response.players || []).map((player) => ({
      id: player.playerId,
      displayName: player.displayName,
      active: true
    }));
  } catch (error) {
    console.warn(error);
    return fallbackPlayers;
  }
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const scoreClient = {
  async start(payload) {
    if (!config.googleScriptUrl) {
      return { ok: true, local: true, runId: `local-${crypto.randomUUID()}`, startedAt: new Date().toISOString() };
    }
    return callGoogleScript({ action: "start", userAgent: navigator.userAgent.slice(0, 240), ...payload });
  },

  async submit(payload) {
    if (!config.googleScriptUrl) {
      const elapsedMs = Date.now() - payload.startedAt;
      const record = {
        ...payload,
        elapsedMs,
        rawScore: calculateScore(elapsedMs, payload.mistakes, payload.hintsUsed),
        submittedAt: new Date().toISOString()
      };
      const existing = JSON.parse(localStorage.getItem("pqLocalSubmissions") || "[]");
      existing.push(record);
      localStorage.setItem("pqLocalSubmissions", JSON.stringify(existing));
      return { ok: true, local: true, ...record };
    }
    return callGoogleScript({ action: "submit", ...payload });
  }
};

function callGoogleScript(params) {
  return new Promise((resolve, reject) => {
    const callbackName = `pqJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const url = new URL(config.googleScriptUrl);
    url.searchParams.set("callback", callbackName);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });

    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The score sheet did not respond."));
    }, 12000);

    function cleanup() {
      window.clearTimeout(timeout);
      delete window[callbackName];
      script.remove();
    }

    window[callbackName] = (payload) => {
      cleanup();
      resolve(payload);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("The score sheet request failed."));
    };
    script.src = url.toString();
    document.head.appendChild(script);
  });
}
