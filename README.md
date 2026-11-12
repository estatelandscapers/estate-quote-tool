# Estate Landscapers — Quote Tool

Quote builder with tiered pricing (Basic/Standard/Premium), trackable client links,
built-in e-signature, site-plan drawings, and a structural checklist.

**Setup:** see `SETUP-GUIDE.md` (written for non-technical setup).

## Run locally
```
npm install
npm start
# admin:  http://localhost:3000/admin
# a quote: http://localhost:3000/q/<token>
```
Node 22.5+ required (uses the built-in SQLite module).

## Environment variables (set on the host)
| Variable | Purpose |
|---|---|
| `DATA_DIR` | Folder for the SQLite database (e.g. `/data` on a mounted volume) |
| `SMTP_HOST` | `smtp.zoho.com` (or `smtp.zoho.com.au`) |
| `SMTP_USER` | `info@estatelandscapers.com.au` |
| `SMTP_PASS` | Zoho **App Password** |
| `BACKUP_KEY` | Secret for the `/api/backup` nightly pull |
| `PORT` | Set automatically by most hosts |
| `ONEDRIVE_INVENTORY_PATH` | OneDrive folder for inventory photos (default `Estate Inventory`). Uses the existing `GRAPH_*` / `ONEDRIVE_USER` variables |
| `INVENTORY_PHOTOS_LOCAL` | `1` = keep inventory photos under `DATA_DIR` instead of OneDrive. Local development only |

Default management PIN is **1234** — change it in Settings on first run.
