# Client Reports

Private backup/documentation repo for `client-reports` in Will's `~/clawd` workspace.

## Purpose

**Domain:** Agency / growth operations

This repository preserves the working code/assets from `~/clawd/client-reports` so the system can be recovered, audited, and handed to agents without relying on the unstructured parent workspace.

## Repository

- Local path: `/home/mgk/clawd/client-reports`
- Remote: `https://github.com/mgkcloud/client-reports-generator.git`
- Backup org: `mgkcloud`
- Approx source files scanned: 385
- Main file types: .jpg×124, .docx×86, .png×83, .md×32, .json×26, .js×14, .py×9, .db×2

## Top-level map

### Files
- `account_merge_helpers.js`
- `BoxDivvy_Weekly_Report_2026-02-20.md`
- `BoxDivvy_Weekly_Report_2026-02-25.md`
- `campaign_dates.json`
- `character_perf.py`
- `config.json`
- `create-ecom-template.js`
- `data_fetcher.py`
- `deliver.py`
- `docx_to_pdf.py`
- `generate_chart.js`
- `generate_chart.js.bak`

### Directories
- `audits/`
- `backups/`
- `character_history/`
- `graphify-out/`
- `reference/`
- `reports/`
- `scripts/`
- `thumbnails/`
- `tmp/`

## Common commands

- `npm run test`

## Safety notes

- Secrets, env files, local databases, caches, build outputs, and large media are intentionally excluded by `.gitignore` where applicable.
- Do not assume this repo contains production secrets. Retrieve credentials through the normal secret manager/workspace flow.
- Commit only reviewed source/config/docs changes. Avoid sweeping generated artifacts into git.
- If this repo controls live client, trading, ads, or outreach behaviour, run the project-specific verification before deploying or sending anything externally.

## Maintenance

When changing this project:

1. Inspect `git status --porcelain` before edits.
2. Keep `.env*`, `*.db`, `*.sqlite`, keys, logs, and media out of commits.
3. Commit small checkpoints with clear messages.
4. Push to the private `mgkcloud` remote after verification.
