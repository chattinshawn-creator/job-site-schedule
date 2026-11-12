# Job Site Schedule on Cloudflare

This folder is the Cloudflare version of the schedule.

- `public/index.html` is the page.
- `functions/api/[[path]].js` is the server (data, passcode, file uploads).

## Cloudflare Pages settings

- Framework preset: None
- Build command: (leave empty)
- Build output directory: `public`
- Root directory: `cloudflare`

## Bindings (Settings > Bindings)

| Type | Variable name | Points to |
|---|---|---|
| D1 database | `DB` | `job-site-schedule` |
| R2 bucket | `FILES` | `job-site-schedule-files` |

## Secret (Settings > Variables and Secrets)

- `TEAM_PASSCODE` (type: Secret) is the passcode people enter to unlock editing.

The database tables are created automatically the first time the site is used.

## Changing the passcode

Edit `TEAM_PASSCODE`, then redeploy (Deployments > ... > Retry deployment).
Devices that are already unlocked stay unlocked. To lock everyone out, open
D1 > job-site-schedule > Console and run: `DELETE FROM editors;`
