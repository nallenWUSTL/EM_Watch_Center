# Briefing data

The scheduled task **WashU EM Daily Intelligence Briefing** files one record each
morning (5:52 AM Central). It writes the record in two places:

1. The Watch Center artifact's database on claude.ai (`briefings/YYYY-MM-DD` and
   `meta/latest`), read live by the artifact page.
2. This folder, committed to `main`, read by the dashboard's **Daily Briefing**
   tab. GitHub Pages redeploys about a minute after the commit, and the tab
   rechecks every five minutes while it is open.

The dashboard and the artifact render from the same code
(`js/briefing-render.js`, `css/briefing.css`), so they always look the same.

## Files

| File | Written | Contents |
| --- | --- | --- |
| `data/briefings/YYYY-MM-DD.json` | one per day; a same-day re-run replaces it | the full record below; identical to the `briefings/YYYY-MM-DD` document |
| `data/latest.json` | overwritten each run | `{date, posture, top_item, briefing_url, published_at}`; identical to `meta/latest` |

`YYYY-MM-DD` is the Central date of the run.

## Record fields

All strings unless noted.

| Field | Meaning |
| --- | --- |
| `date` | ISO date, Central |
| `title` | "WashU EM Daily Intelligence Briefing, Month D, YYYY" |
| `posture` | `Normal` \| `Elevated` \| `High` |
| `published_at` | ISO 8601 UTC timestamp |
| `run_note` | one line on run status (late, lane omitted, charter unreadable) |
| `briefing_url` | link to that day's full briefing artifact |
| `bluf` | 3 to 5 sentences |
| `top_item` | one sentence |
| `today_items[]` | `{rank:int, title, pir:int, severity:int 1-5, likelihood, confidence, ttd, action, owner, source}`; `ttd` is `Now` or `Today` |
| `pirs[]` | six entries `{pir:int, name, status:"quiet"|"watch"|"active", summary}` |
| `lookahead[]` | seven entries `{date, dow, wx, stacked:bool, loads}` |
| `dissents[]` | `{title, verdict, note}` |
| `lanes_quiet[]` | ints: PIR numbers whose lane reported nothing above threshold |
| `unreachable[]` | source names that could not be reached this run |

`briefings/2026-10-20.json` is a complete example.

## How the files get here

The briefing and water tasks write only the artifact database; they cannot
push to GitHub, because a task-spawned session starts with no repository
attached. A separate **Watch Center sync** session, created with this
repository attached, copies the database to `data/` and pushes to `main`. Two
scheduled tasks wake it: 6:12 AM Central (after the daily briefing) and hourly
at :48 (after each water run). It resets to `origin/main`, rewrites only the
files that differ, commits as `Sync briefing and water watch <date time> CT`,
and never touches anything else. A manual "Run Now" on the briefing or water
task reaches the dashboard at the next sync; a same-day briefing re-run
replaces that day's file and `latest.json`, and the tab picks it up because
`published_at` changed.

## Water watch

The scheduled task **WashU Water Utility Incident Watch** runs hourly. It writes
its state to the same artifact database (collection `water_incidents`, one
document per incident, and `meta/water_watch_latest`), then commits the same
state here as one file, read by the Outages tab's Water strip:

| File | Written | Contents |
| --- | --- | --- |
| `data/water_watch.json` | overwritten each run | `{ "latest": <meta/water_watch_latest>, "incidents": [ <every water_incidents document> ] }` |

`latest` fields: `run_at` (ISO 8601 UTC), `open_count` (int), `alert_level`
(`normal` \| `watch` \| `alert`), `top_incident`, `note`.

Incident fields: `id`, `title`, `utility`, `location`, `ring` (1–3), `status`
(`open` \| `monitoring` \| `resolved`), `first_seen`, `last_updated` (ISO 8601
UTC), `assessment`, `washu_impact` (`none` \| `possible` \| `likely` \|
`confirmed`), `confidence` (`Low` \| `Medium` \| `High`), `single_source`
(bool), `affected_assets[]`, `sources[]`.

The strip shows incidents whose status is not `resolved`, newest
`last_updated` first; resolved rows stay in the file so the archive is
complete. The commit path is the same as the briefing's: attach the repository
with push access, clone, overwrite the file, commit `Water watch <date time>
CT`, rebase and push to `main`; "nothing to commit" is a normal outcome.

## Republishing the artifact page

`artifact/briefing-watch.html` is generated: edit `artifact/template.html`,
`css/briefing.css` or `js/briefing-render.js`, run `node artifact/build.js`,
and republish the result to the existing artifact URL in `js/config.js`
(`briefingUrl`). Republishing to a new URL would start an empty database, so
keep the URL.
