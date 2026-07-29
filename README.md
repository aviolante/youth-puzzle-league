# Youth Puzzle League

A static weekly puzzle site for a church youth group. It has two games each week — a Connections board and a Strands word board, both drawn from that week's Come Follow Me reading — plus a "This Week" reading tab and a leaderboard. The site runs on GitHub Pages, records official starts and submissions through Google Apps Script, and publishes finalized leaderboard JSON files back into the repo.

## Local Run

```bash
npm run dev
```

Then open `http://localhost:5173`.

With the default `config.js`, scores are stored only in browser local storage. Add a Google Apps Script URL to make runs official.

## Google Sheets Setup

1. Create a new Google Sheet.
2. Open `Extensions > Apps Script`.
3. Paste the contents of `scripts/google-apps-script/Code.gs`.
4. Save, then run the `setup` function once.
5. Run the `showAdminKey` function once and copy the value from the execution log. Keep it private.
6. In the Google Sheet, edit the `Players` tab:
   - `playerId`: stable lowercase id, like `player1`
   - `displayName`: public name
   - `pin`: private PIN
   - `active`: `TRUE` or `FALSE`
   - `admin`: `TRUE` unlocks the in-app preview/answer tools for that player (optional)
7. Deploy the script:
   - `Deploy > New deployment`
   - Type: `Web app`
   - Execute as: `Me`
   - Who has access: `Anyone`
8. Copy the web app URL into `config.js`:

```js
window.PQ_CONFIG = {
  googleScriptUrl: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
  groupName: "Youth Puzzle League"
};
```

Do not put player PINs or the admin key in this repo.

### Self-service sign-ups

Players sign in by typing their own name and PIN — the roster is never served
publicly. To let people add themselves instead of you adding every row by hand,
put a shared join code in the `Config` tab (`joinCode`) and give it to the group.
A blank `joinCode` means sign-ups are closed. Changing it takes effect
immediately; no redeploy needed.

New players get an opaque `playerId` and land `active`, `admin = FALSE`. Display
names must be unique — season totals key on them — so registration rejects a
name that is already taken.

## Weekly Puzzle Workflow

1. Create a puzzle file in `data/puzzles`, for example `data/puzzles/2026-week-23.json`.
2. Update `data/current.json` to point to the new puzzle id.
3. Commit and push to GitHub Pages.
4. After the deadline, finalize scores:

```bash
PQ_GOOGLE_SCRIPT_URL="https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec" \
PQ_ADMIN_KEY="YOUR_ADMIN_KEY" \
npm run finalize:week -- --puzzle 2026-week-23
```

To preview scoring without writing files, add `--dry-run`.

6. Commit and push the updated files:
   - `data/leaderboards/2026-week-23.json`
   - `data/leaderboards/season.json`

## Content Sources

Use `content/sources/` for raw PDFs, scripture exports, temple lists, CSVs, or other source material. That folder is ignored by git so source files do not get published to GitHub Pages by accident.

Use `content/processed/` for local extracted text and draft puzzle candidates.

Use `data/puzzles/` only for reviewed weekly puzzle JSON that the site should load publicly.

## Scoring

Official elapsed time is calculated by Google Apps Script from the recorded start time and submit time.

Raw score:

```text
max(0, 1000 - elapsedSeconds * 1 - mistakes * 25 - hintsUsed * 50)
```

Weekly points:

```text
1st: 100
2nd: 90
3rd: 80
4th: 70
5th: 60
6th and lower: minus 5 per rank, floor of 25
```

The first completed official submission for a player and puzzle counts.

## Notes

- The app is intentionally static so it can run on GitHub Pages.
- Google Apps Script validates player PINs and keeps the private roster in Google Sheets.
- This is not high-security anti-cheat infrastructure. It is appropriate for a friendly youth group game, with server-timed runs and first-score-wins rules.
- For doctrine-related puzzles, keep a human review step before publishing.
