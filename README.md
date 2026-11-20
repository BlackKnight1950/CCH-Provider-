# CCH Provider Finder

Call center lookup for scheduling. Agents type a provider name to see every location where that provider practices, or type a location to see its providers. The data comes live from two Smartsheet sheets, so edits in Smartsheet show up without changing any code.

Same setup as the Consent Form Library:

| Part | Where it runs | Files |
|---|---|---|
| The page agents use | **GitHub Pages**: `https://blackknight1950.github.io/CCH-Provider-/` | `index.html`, `config.js`, `fonts/` |
| The Smartsheet reader (API) | **Render**: `https://cch-provider-finder.onrender.com` | `server.js`, `package.json` |

| Data | Smartsheet sheet | Sheet ID |
|---|---|---|
| Find by provider (name, specialty, languages) | Provider Lookup | `4254079686758276` |
| Find by location, and each provider's sites with new-patient / gender status | By Location | `4255312342372228` |

## Repository layout (everything at the top level)

```
index.html          the page (GitHub Pages serves this)
config.js           one line: the Render address the page talks to
fonts/              IBM Plex Sans files used by the page
server.js           the API (Render runs this)
package.json        Render installs from this
package-lock.json
render.yaml         optional Render Blueprint
README.md
.gitignore
```

## How updates reach agents

1. Someone edits either sheet in Smartsheet.
2. The Render server checks both sheets' version numbers at most every 30 seconds (a very small request). If a version changed, it re-reads both sheets.
3. Each open page asks the server for changes every minute and when the tab becomes active again, then redraws without losing the agent's search.

Expect edits to appear within about 1½ minutes. No redeploy and no GitHub change is needed, including when rows or columns are added.

## What the app uses from each sheet

Columns are found by title (not position), so reordering columns is safe. Keep these titles recognisable: `Provider Name`, `Service / Specialty`, `Languages Spoken …`, `Accepting New Patients`, `Gender Accepted`, and on the By Location sheet `CCH Location`.

- **By Location sheet** drives the location view and the per-site status on each provider card.
- **Provider Lookup sheet** supplies each provider's specialty and languages. Its `# Sites` and `Locations` columns are only a fallback for a provider that has no rows on the By Location sheet.
- Providers are matched between the sheets by name (ignoring capitalisation and extra spaces). A provider who is on only one sheet is still shown.
- Blank stays blank. The older "Not listed – verify" placeholder is also shown as blank.
- Display wording: `New & Existing` → "Accepts New & Existing patients"; `Both` → "Accepts Male and Female patients". `Male` / `Female`, `Accepting New`, `Existing`, and `Closed` are also understood; any other text is shown as typed.
- Languages can be separated by commas or semicolons.

## Set-up

### 1. GitHub Pages (the page)
Repository **Settings → Pages**: Source **Deploy from a branch**, branch **main**, folder **/ (root)**. The page appears at `https://blackknight1950.github.io/CCH-Provider-/` a minute or two after each commit.

### 2. Render (the API)
**New → Web Service**, connect this repository.

- Name: `cch-provider-finder` (this gives the address `https://cch-provider-finder.onrender.com`; if Render adds letters to the name, copy the real address into `config.js`)
- Runtime: **Node**
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/healthz`
- Instance type: **Starter** for always-on (free works but sleeps, see below)

Environment variables:

| Variable | Value |
|---|---|
| `SMARTSHEET_API_KEY` | A Smartsheet API token for an account that can view both sheets (the token used for the Consent app works) |
| `ALLOWED_ORIGINS` | Optional. Default `https://blackknight1950.github.io`. Comma-separate to allow more; `*` allows any site |
| `PROVIDER_SHEET_ID`, `LOCATION_SHEET_ID` | Optional. Defaults are the two sheet IDs above |
| `REFRESH_SECONDS` | Optional. How often the server checks the sheets. Default 30 |

### 3. Connect the two
If the Render address is not `https://cch-provider-finder.onrender.com`, edit `config.js` on GitHub (pencil icon) and paste the real address between the quotes. Commit, and wait a minute for Pages.

### 4. Check it
Open `https://<your-render-address>/api/status`. It lists the sheet names, row counts, which columns were found, and data checks (for example providers that appear on only one sheet). Then open the GitHub Pages address.

### Render free plan
Free web services go to sleep after about 15 minutes without traffic, and the first visit afterwards can take up to a minute (the page says so while it waits). For a call center, use **Starter**, or point a free uptime monitor at `/healthz` every 10 minutes.

## Security notes

- The Smartsheet token lives only in the Render environment. It is never sent to the browser or stored in the repository.
- There is no password. Anyone who has the page address can open it, and anyone who knows the Render address can read the same data from it. The page asks search engines not to index it, but that is not access control.
- The API only answers browsers on the allowed origin (`ALLOWED_ORIGINS`). That keeps other websites from embedding your data, but it does not stop someone calling the API directly.
- Rotate the Smartsheet token in Render if it is ever shared.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Page says "no data server address yet" | `config.js` still has a placeholder address |
| Page says it could not reach the data server | Render is asleep (wait a minute), the service name differs from `config.js`, or the service is not deployed |
| Page says the list could not be loaded, with another message | The API is up but Smartsheet failed. `/api/status` on Render shows why (token missing or expired, or no access to a sheet) |
| Page shows "could not refresh, showing last saved data" | Smartsheet could not be reached; the page keeps the last good data and retries |
| A provider shows no locations | They have no row on the By Location sheet and nothing in the Provider Lookup `Locations` column |
| The same person appears twice | Their name is spelled differently on the two sheets |

## Run locally

```
npm install
SMARTSHEET_API_KEY=your-token ALLOWED_ORIGINS='*' npm start
```
Then serve the folder with any static server and set `config.js` to `http://localhost:3000`.
