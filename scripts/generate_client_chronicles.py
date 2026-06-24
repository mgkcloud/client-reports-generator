#!/usr/bin/env python3
"""Generate per-client chronicles from historical reports and Gmail metadata.

Read-only by design: no email sending, no Drive writes, no secret output.
"""

from __future__ import annotations

import argparse
import base64
import glob
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "state.db"
CONFIG_PATH = ROOT / "config.json"

GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_date(value: str | None) -> str:
    if not value:
        return ""
    try:
        return parsedate_to_datetime(value).date().isoformat()
    except Exception:
        pass
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%a, %d %b %Y %H:%M:%S %z"):
        try:
            return datetime.strptime(value[:25], fmt).date().isoformat()
        except Exception:
            continue
    match = re.search(r"(20\d{2}-\d{2}-\d{2})", value)
    return match.group(1) if match else ""


def client_by_id(client_id: int) -> dict[str, Any]:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    row = con.execute(
        "SELECT id, name, account_id, drive_folder, active, created_at FROM clients WHERE id = ?",
        (client_id,),
    ).fetchone()
    con.close()
    if not row:
        raise SystemExit(f"client not found: {client_id}")
    return dict(row)


def get_reports(client_id: int, since: str) -> list[dict[str, Any]]:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        WITH ranked AS (
          SELECT
            r.*,
            c.name AS client_name,
            c.account_id,
            ROW_NUMBER() OVER (
              PARTITION BY r.client_id, r.start_date, r.end_date
              ORDER BY datetime(COALESCE(r.completed_at, r.created_at)) DESC, r.id DESC
            ) AS rn
          FROM reports r
          JOIN clients c ON c.id = r.client_id
          WHERE r.client_id = ?
            AND r.start_date >= ?
            AND COALESCE(r.status, '') NOT IN ('error', 'archived')
        )
        SELECT * FROM ranked
        WHERE rn = 1
        ORDER BY start_date DESC, id DESC
        """,
        (client_id, since),
    ).fetchall()
    con.close()

    reports: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item.pop("rn", None)
        docx_path = item.get("docx_path")
        html_path = item.get("html_path")
        item["docx_exists"] = bool(docx_path and Path(str(docx_path)).exists())
        item["html_exists"] = bool(html_path and Path(str(html_path)).exists())
        reports.append(item)
    return reports


def find_config_client(config: dict[str, Any], client_name: str) -> dict[str, Any]:
    for c in config.get("clients", []):
        if c.get("name") == client_name:
            return c
    return {}


def default_email_terms(client_name: str) -> list[str]:
    compact = re.sub(r"[^a-z0-9]", "", client_name.lower())
    terms = [f'"{client_name}"']
    if compact:
        terms.append(compact)
    if "needle" in client_name.lower():
        terms.extend(['"Comfort-In"', "injectneedlefree", "hadar"])
    if "box" in client_name.lower():
        terms.extend(["boxdivvy", "boxdivvy.com.au"])
    return terms


def gmail_service(config: dict[str, Any]):
    import socket
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    socket.setdefaulttimeout(12)
    creds_file = os.path.expanduser(config.get("google_creds", "~/.secrets/google-service-account.json"))
    subject = config.get("google_subject", "will@feistyagency.com")
    creds = service_account.Credentials.from_service_account_file(
        creds_file,
        scopes=[GMAIL_SCOPE],
    ).with_subject(subject)
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def header_value(headers: list[dict[str, str]], name: str) -> str:
    lname = name.lower()
    for h in headers:
        if h.get("name", "").lower() == lname:
            return h.get("value", "")
    return ""


def clean_snippet(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()[:360]


def get_emails(config: dict[str, Any], client_config: dict[str, Any], client_name: str, since: str, max_emails: int) -> list[dict[str, Any]]:
    if max_emails <= 0:
        return []

    terms = client_config.get("email_query_terms") or default_email_terms(client_name)
    term_query = " OR ".join(f"({term})" for term in terms)
    query = f"after:{since.replace('-', '/')} ({term_query}) -category:promotions -category:social"

    try:
        service = gmail_service(config)
        response = service.users().messages().list(userId="me", q=query, maxResults=max_emails).execute()
    except Exception as e:
        return [{
            "date": "",
            "type": "email_error",
            "subject": "Gmail scan failed",
            "from": "",
            "snippet": str(e)[:240],
            "thread_id": "",
            "message_id": "",
            "query": query,
        }]

    emails: list[dict[str, Any]] = []
    for ref in response.get("messages", []):
        try:
            msg = service.users().messages().get(
                userId="me",
                id=ref["id"],
                format="metadata",
                metadataHeaders=["Subject", "From", "To", "Date"],
            ).execute()
            headers = msg.get("payload", {}).get("headers", [])
            subject = header_value(headers, "Subject")
            sender = header_value(headers, "From")
            to = header_value(headers, "To")
            date_raw = header_value(headers, "Date")
            emails.append({
                "date": parse_date(date_raw),
                "type": "email",
                "subject": subject,
                "from": sender,
                "to": to,
                "snippet": clean_snippet(msg.get("snippet", "")),
                "thread_id": msg.get("threadId", ""),
                "message_id": msg.get("id", ""),
            })
        except Exception:
            continue
    emails.sort(key=lambda x: x.get("date") or "", reverse=True)
    return emails


def historical_notes(client_name: str, since: str) -> list[dict[str, Any]]:
    notes: list[dict[str, Any]] = []
    needle = client_name.lower().replace(" (comfort-in)", "")
    aliases = [needle]
    if "needle" in needle:
        aliases.extend(["needlefree", "comfort-in", "hadar"])
    if "box" in needle:
        aliases.extend(["box divvy", "boxdivvy", "jayne", "richard"])

    for path in sorted(glob.glob(str(ROOT / "revision-requests-*.md")), reverse=True):
        text = Path(path).read_text(encoding="utf-8", errors="replace")
        lowered = text.lower()
        if not any(alias in lowered for alias in aliases):
            continue
        date = parse_date(Path(path).stem)
        if date and date < since:
            continue
        snippets: list[str] = []
        for alias in aliases[:4]:
            idx = lowered.find(alias)
            if idx >= 0:
                start = max(0, idx - 300)
                end = min(len(text), idx + 900)
                block = text[start:end]
                block = re.sub(r"\n{3,}", "\n\n", block).strip()
                snippets.append(block[:900])
                break
        notes.append({
            "date": date,
            "type": "historical_note",
            "title": Path(path).name,
            "source": str(path),
            "snippet": snippets[0] if snippets else text[:900],
        })
    return notes[:12]


def timeline_from(reports: list[dict[str, Any]], emails: list[dict[str, Any]], notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    timeline: list[dict[str, Any]] = []
    for r in reports:
        timeline.append({
            "date": r.get("end_date") or r.get("start_date") or "",
            "type": "report",
            "title": f"Weekly report: {r.get('start_date')} to {r.get('end_date')}",
            "detail": f"Status {r.get('status', 'unknown')} · report #{r.get('id')}",
            "source": "state.db",
            "report_id": r.get("id"),
            "docx_exists": r.get("docx_exists"),
            "html_exists": r.get("html_exists"),
        })
    for e in emails:
        timeline.append({
            "date": e.get("date") or "",
            "type": e.get("type", "email"),
            "title": e.get("subject") or "Client email",
            "detail": f"{e.get('from', '')} · {e.get('snippet', '')}".strip(" ·"),
            "source": "gmail",
            "thread_id": e.get("thread_id"),
            "message_id": e.get("message_id"),
        })
    for n in notes:
        timeline.append({
            "date": n.get("date") or "",
            "type": "historical_note",
            "title": n.get("title") or "Historical note",
            "detail": clean_snippet(n.get("snippet", "")),
            "source": n.get("source"),
        })
    timeline.sort(key=lambda x: x.get("date") or "", reverse=True)
    return timeline[:80]


def open_items(emails: list[dict[str, Any]], notes: list[dict[str, Any]]) -> list[str]:
    terms = ["revision", "approve", "approval", "change", "issue", "urgent", "fix", "pending", "outstanding"]
    items: list[str] = []
    for e in emails[:20]:
        blob = f"{e.get('subject','')} {e.get('snippet','')}".lower()
        if any(t in blob for t in terms):
            subject = e.get("subject") or "Client email"
            items.append(f"{e.get('date') or 'unknown'} · {subject}")
    for n in notes[:6]:
        blob = n.get("snippet", "").lower()
        if any(t in blob for t in terms):
            items.append(f"{n.get('date') or 'unknown'} · historical revision note")
    return list(dict.fromkeys(items))[:10]


def build_chronicle(client_id: int, since: str, max_emails: int) -> dict[str, Any]:
    config = load_config()
    client = client_by_id(client_id)
    client_config = find_config_client(config, client["name"])
    reports = get_reports(client_id, since)
    emails = get_emails(config, client_config, client["name"], since, max_emails)
    notes = historical_notes(client["name"], since)
    timeline = timeline_from(reports, emails, notes)

    return {
        "client": client,
        "generated_at": iso_now(),
        "period": {"since": since, "through": datetime.now().date().isoformat()},
        "summary": {
            "report_count": len(reports),
            "email_count": len([e for e in emails if e.get("type") == "email"]),
            "historical_note_count": len(notes),
            "open_items": open_items(emails, notes),
            "latest_report": reports[0] if reports else None,
            "latest_client_email": emails[0] if emails else None,
            "sources": ["state.db", "gmail_service_account", "revision_request_markdown"],
        },
        "timeline": timeline,
        "reports": reports,
        "emails": emails,
        "historical_notes": notes,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-id", type=int, required=True)
    parser.add_argument("--since", default="2026-01-01")
    parser.add_argument("--max-emails", type=int, default=50)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if not re.match(r"^20\d{2}-\d{2}-\d{2}$", args.since):
        raise SystemExit("--since must be YYYY-MM-DD")

    max_emails = max(0, min(args.max_emails, 100))
    chronicle = build_chronicle(args.client_id, args.since, max_emails)
    print(json.dumps(chronicle, indent=None if args.json else 2, ensure_ascii=False))


if __name__ == "__main__":
    main()
