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
| `data/briefings/YYYY-MM-DD.json` | one per day, never overwritten | the full record below; identical to the `briefings/YYYY-MM-DD` document |
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

## How the task commits here

The task runs in a Claude Code Remote session. After its artifact-database
write it attaches this repository with push access, clones it, writes the two
files above, commits with the message `Briefing YYYY-MM-DD`, and pushes to
`main`. It changes nothing else in the repository. If the attach, clone or push
fails, it skips the step and says so in the published briefing's Analytic Note;
the dashboard then keeps showing the previous day's record and names the
failure in the tab's footer.

## Republishing the artifact page

`artifact/briefing-watch.html` is generated: edit `artifact/template.html`,
`css/briefing.css` or `js/briefing-render.js`, run `node artifact/build.js`,
and republish the result to the existing artifact URL in `js/config.js`
(`briefingUrl`). Republishing to a new URL would start an empty database, so
keep the URL.
