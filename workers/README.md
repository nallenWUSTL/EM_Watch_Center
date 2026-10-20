# Cloudflare Workers

Source for the two Workers the dashboard reads through. Deploy from the
Cloudflare dashboard (paste `worker.js` into the Worker's editor and Deploy) or
with `npx wrangler deploy` from the Worker's folder.

- `ameren-outage-worker/` — `washu-em-ameren`: `/ameren`, `/metro`, `/localnews`,
  `/crashes`, `/healthnews`, `/cybernews`, `/ransomware`, `/stlwater`. No secrets.
- `feeds-proxy/` — `washu-em-feeds`: `/ahps`, `/bluesky`, `/airnow`, `/modot`,
  `/reddit`. Keyed routes need `wrangler secret put AIRNOW_KEY` etc.

The default Worker address the dashboard uses is `workerOrigin` in `js/config.js`.
