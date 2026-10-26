#!/usr/bin/env python3
"""Weekly client report emails.

For each active client:
  generate report (canonical Node generator, Meta Graph data)
  -> upload DOCX to the client's Drive Reports folder, share link
  -> gather workstream evidence from recent client mail (Gmail readonly, DWD)
  -> DeepSeek extracts workstream items -> Jev gates each item
  -> DeepSeek writes the email in Will's voice from real sent examples
  -> code validates shape + every number against the report text
  -> Gmail draft (needs gmail.compose delegation) else local .eml/.txt
Prints a Telegram-ready packet on stdout. Never sends email.

Usage:
  weekly_client_emails.py                 # previous Mon-Sun, all active clients
  weekly_client_emails.py --reuse         # reuse an existing report for the window
  weekly_client_emails.py --client boxdivvy --since 2026-09-14 --until 2026-09-20
"""
import argparse, base64, html, json, os, re, sqlite3, subprocess, sys, time
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path(__file__).resolve().parent
CFG = json.loads((BASE / "config.json").read_text())
DB = BASE / "state.db"
SA = os.path.expanduser(CFG["google_creds"])
SUBJECT_USER = CFG["google_subject"]
MODEL = os.environ.get("CLIENT_EMAIL_MODEL", "deepseek/deepseek-v4.1-flash")
# OpenRouter account balance went negative on 2026-10-04 (402 on every model,
# every key). MiniMax is funded and already the BDA fleet's primary; fall back
# to it so Monday client reports ship instead of BLOCKED. Remove once OpenRouter
# is topped up and preflight goes green again.
MINIMAX_URL = "https://api.minimax.io/v1/text/chatcompletion_v2"
MINIMAX_MODEL = os.environ.get("CLIENT_EMAIL_MINIMAX_MODEL", "MiniMax-M3")
MINIMAX_HEADROOM = 2400  # reasoning tokens eat max_tokens before content (BDA-measured)

# CCR (local Claude Code Router, 127.0.0.1:3467) is the primary route. The
# OpenRouter balance died on 2026-10-04 and stayed dead through the 2026-10-26
# Monday run, so the report job had no funded LLM. CCR runs on Will's own
# Claude subscription, so drafting costs nothing per token. Route order is
# overridable with CLIENT_EMAIL_LLM_ROUTE=ccr,openrouter,minimax.
CCR_URL = os.environ.get("CLIENT_EMAIL_CCR_URL", "http://127.0.0.1:3467/v1/chat/completions")
CCR_MODEL = os.environ.get("CLIENT_EMAIL_CCR_MODEL", "Claude DirectSDK/claude-sonnet-5")
# Claude via DirectSDK spends a large slice of max_tokens on reasoning tokens
# before it emits any content. On the real client-report prompts (full report
# text + evidence) a 4000-token budget was consumed entirely by reasoning and
# the call came back empty with finish_reason=length. Headroom + one doubling
# retry fixes it; the subscription route makes the extra tokens free.
CCR_HEADROOM = int(os.environ.get("CLIENT_EMAIL_CCR_HEADROOM", "12000"))
LLM_ROUTE = os.environ.get("CLIENT_EMAIL_LLM_ROUTE", "ccr,openrouter,minimax")


def minimax_key() -> str:
    try:
        return subprocess.run(
            ["bash", str(Path.home() / "clawd" / "scripts" / "secrets.sh"), "get", "minimax_api_key"],
            capture_output=True, text=True).stdout.strip()
    except Exception:
        return ""
sys.path.insert(0, str(Path.home() / "clawd/scripts"))


# ── keys ────────────────────────────────────────────────────────────────
def openrouter_key() -> str:
    # Dedicated key first; the shared OPENROUTER_API_KEY hits its daily cap.
    for p in ("client-reports-openrouter-key-api-key.txt", "jev-openrouter-key-api-key.txt"):
        f = Path.home() / ".secrets" / p
        if f.exists() and f.read_text().strip():
            return f.read_text().strip()
    return os.environ.get("OPENROUTER_API_KEY", "").strip()


def _llm_minimax(system: str, user: str, max_tokens: int) -> str:
    key = minimax_key()
    if not key:
        raise RuntimeError("MiniMax fallback unavailable: no minimax_api_key in secrets")

    def call(token_limit: int) -> dict:
        body = json.dumps({
            "model": MINIMAX_MODEL, "max_tokens": token_limit,
            "temperature": 0.4,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
        }).encode()
        req = urllib.request.Request(MINIMAX_URL, data=body,
                                     headers={"Authorization": f"Bearer {key}",
                                              "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = json.load(r)
        # MiniMax returns HTTP 200 with base_resp.status_code != 0 on a dead key
        status = (raw.get("base_resp") or {}).get("status_code", 0)
        if status:
            raise RuntimeError(f"MiniMax error {status}: {(raw.get('base_resp') or {}).get('status_msg')}")
        return raw

    raw = call(max_tokens + MINIMAX_HEADROOM)
    choice = (raw.get("choices") or [{}])[0]
    content = (choice.get("message") or {}).get("content") or ""
    # reasoning tokens eat max_tokens before content; the thinking tail always
    # terminates, it just needs room (same fix as BDA email_reply_generate).
    if not content.strip() and choice.get("finish_reason") == "length":
        raw = call(12000)
        choice = (raw.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content") or ""
    if not content.strip():
        raise RuntimeError(f"MiniMax empty content (finish_reason="
                           f"{choice.get('finish_reason')})")
    return content


def ccr_key() -> str:
    try:
        out = subprocess.run(
            ["bash", str(Path.home() / "clawd" / "scripts" / "secrets.sh"), "get", "ccr-local-gateway"],
            capture_output=True, text=True).stdout.strip()
        if out:
            return out
    except Exception:
        pass
    return os.environ.get("CCR_GATEWAY_API_KEY", "").strip()


def _llm_ccr(system: str, user: str, max_tokens: int) -> str:
    key = ccr_key()
    if not key:
        raise RuntimeError("CCR unavailable: no ccr-local-gateway key")
    budget = max(int(max_tokens), 2000) + CCR_HEADROOM
    last = "no attempt"
    for attempt in range(2):
        body = json.dumps({"model": CCR_MODEL, "max_tokens": budget, "temperature": 0.4,
                           "messages": [{"role": "system", "content": system},
                                        {"role": "user", "content": user}]}).encode()
        req = urllib.request.Request(CCR_URL, data=body,
                                     headers={"Authorization": f"Bearer {key}",
                                              "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                raw = json.load(r)
        except urllib.error.HTTPError as e:
            body_txt = e.read().decode()[:200]
            if e.code in (400, 413) and attempt == 0:
                last = f"HTTP {e.code}: {body_txt}"
                budget *= 2
                continue
            raise RuntimeError(f"CCR HTTP {e.code}: {body_txt}")
        choice = (raw.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content") or ""
        if content.strip():
            return content
        last = f"empty content (finish_reason={choice.get('finish_reason')})"
        budget *= 2
    raise RuntimeError(f"CCR {last}")


def _llm_openrouter(system: str, user: str, max_tokens: int) -> str:
    body = json.dumps({"model": MODEL, "max_tokens": max_tokens, "temperature": 0.4,
                       "reasoning": {"effort": "low"},
                       "messages": [{"role": "system", "content": system},
                                    {"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=body,
                                 headers={"Authorization": f"Bearer {openrouter_key()}",
                                          "Content-Type": "application/json"})
    last_err = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                content = json.load(r)["choices"][0]["message"].get("content")
                if content:
                    return content
                last_err = "empty content"
                time.sleep(2)
                continue
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:300]
            if e.code in (401, 402, 403):
                # Account-level block (negative balance / dead key): retrying or
                # swapping OpenRouter models cannot help. Let the route chain
                # fall through to the next provider.
                raise RuntimeError(f"DeepSeek via OpenRouter HTTP {e.code}: {msg}")
            last_err = f"HTTP {e.code}: {msg}"
            time.sleep(3 * (attempt + 1))
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"DeepSeek call failed after retries ({last_err})")


def llm(system: str, user: str, max_tokens: int = 1200) -> str:
    routes = [r.strip() for r in LLM_ROUTE.split(",") if r.strip()]
    errors = []
    for route in routes:
        try:
            if route == "ccr":
                out = _llm_ccr(system, user, max_tokens)
            elif route == "openrouter":
                out = _llm_openrouter(system, user, max_tokens)
            elif route == "minimax":
                out = _llm_minimax(system, user, max_tokens)
            else:
                errors.append(f"{route}: unknown route")
                continue
            print(f"[llm] route={route} model="
                  f"{CCR_MODEL if route == 'ccr' else (MODEL if route == 'openrouter' else MINIMAX_MODEL)}",
                  file=sys.stderr, flush=True)
            return normalise_typo(out)
        except Exception as e:
            errors.append(f"{route}: {type(e).__name__}: {str(e)[:200]}")
    raise RuntimeError("all LLM routes failed -> " + " | ".join(errors))


def llm_json(system: str, user: str, max_tokens: int = 1500):
    sys_msg = system + "\nReturn ONLY valid JSON, no prose, no code fences."
    last = None
    for _ in range(3):
        raw = llm(sys_msg, user, max_tokens)
        raw = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.M).strip()
        m = re.search(r"[\[{].*[\]}]", raw, re.S)
        try:
            return json.loads(m.group(0) if m else raw)
        except json.JSONDecodeError as e:
            last = e
            max_tokens = int(max_tokens * 1.6)
            user += "\n\nYour previous reply was not valid JSON. Return only the JSON, shorter if needed."
    raise last or RuntimeError("no JSON returned")


# ── google ──────────────────────────────────────────────────────────────
def gsvc(api, ver, scope):
    from google.oauth2 import service_account
    import googleapiclient.discovery as disc
    c = service_account.Credentials.from_service_account_file(SA, scopes=[scope], subject=SUBJECT_USER)
    return disc.build(api, ver, credentials=c, cache_discovery=False)


def _plain(payload):
    if payload.get("mimeType") == "text/plain" and payload.get("body", {}).get("data"):
        return payload["body"]["data"]
    for p in payload.get("parts", []) or []:
        d = _plain(p)
        if d:
            return d
    return payload.get("body", {}).get("data")


def clean_body(text: str) -> str:
    text = re.split(r"\r?\nOn .{3,120}wrote:|\r?\n-----Original Message|\r?\nFrom: |\r?\n>", text)[0]
    text = re.split(r"\r?\n\s*William Varney\s*\r?\n\s*Co-Founder", text)[0]
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return re.sub(r"\n{3,}", "\n\n", text.replace("\r", "")).strip()


# Will's sent corpus is ASCII punctuation: 120 straight apostrophes against 2
# curly ones across 78 messages. Claude returns typographic quotes by default,
# which is a small but real fingerprint mismatch on a client email. Normalise
# before anything sees the draft.
TYPO = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"',
    "–": "-", "—": "-", "‒": "-", "―": "-",
    "…": "...", " ": " ", " ": " ", " ": " ",
}


def normalise_typo(text: str) -> str:
    for bad, good in TYPO.items():
        if bad in text:
            text = text.replace(bad, good)
    return text


def gmail_messages(query: str, limit: int):
    g = gsvc("gmail", "v1", "https://www.googleapis.com/auth/gmail.readonly")
    out = []
    for m in g.users().messages().list(userId="me", q=query, maxResults=limit).execute().get("messages", []):
        full = g.users().messages().get(userId="me", id=m["id"], format="full").execute()
        h = {x["name"].lower(): x["value"] for x in full["payload"].get("headers", [])}
        data = _plain(full["payload"])
        body = base64.urlsafe_b64decode(data).decode("utf-8", "ignore") if data else full.get("snippet", "")
        out.append({"id": m["id"], "date": h.get("date", ""), "from": h.get("from", ""),
                    "to": h.get("to", ""), "subject": h.get("subject", ""), "body": clean_body(body)[:1200]})
    return out


def gmail_message(mid: str):
    g = gsvc("gmail", "v1", "https://www.googleapis.com/auth/gmail.readonly")
    full = g.users().messages().get(userId="me", id=mid, format="full").execute()
    h = {x["name"].lower(): x["value"] for x in full["payload"].get("headers", [])}
    data = _plain(full["payload"])
    body = base64.urlsafe_b64decode(data).decode("utf-8", "ignore") if data else full.get("snippet", "")
    return {"id": mid, "subject": h.get("subject", ""), "date": h.get("date", ""), "body": clean_body(body)}


def drive_upload(docx: Path, parent_folder: str, name: str) -> str:
    from googleapiclient.http import MediaFileUpload
    d = gsvc("drive", "v3", "https://www.googleapis.com/auth/drive")
    q = (f"'{parent_folder}' in parents and name='Reports' and "
         "mimeType='application/vnd.google-apps.folder' and trashed=false")
    found = d.files().list(q=q, fields="files(id)", supportsAllDrives=True,
                           includeItemsFromAllDrives=True).execute().get("files", [])
    folder = found[0]["id"] if found else d.files().create(
        body={"name": "Reports", "mimeType": "application/vnd.google-apps.folder", "parents": [parent_folder]},
        fields="id", supportsAllDrives=True).execute()["id"]
    media = MediaFileUpload(str(docx), mimetype=
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    same = d.files().list(q=f"'{folder}' in parents and name='{name}' and trashed=false",
                          fields="files(id)", supportsAllDrives=True,
                          includeItemsFromAllDrives=True).execute().get("files", [])
    if same:
        f = d.files().update(fileId=same[0]["id"], media_body=media, fields="id,webViewLink",
                             supportsAllDrives=True).execute()
    else:
        f = d.files().create(body={"name": name, "parents": [folder]}, media_body=media,
                             fields="id,webViewLink", supportsAllDrives=True).execute()
        d.permissions().create(fileId=f["id"], body={"type": "anyone", "role": "reader"},
                               supportsAllDrives=True).execute()
    return f["webViewLink"].split("?")[0] + "?usp=sharing"


def gmail_draft(msg: EmailMessage):
    """Returns (draft_id, None) or (None, reason)."""
    try:
        g = gsvc("gmail", "v1", "https://www.googleapis.com/auth/gmail.compose")
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        d = g.users().drafts().create(userId="me", body={"message": {"raw": raw}}).execute()
        return d["id"], None
    except Exception as e:
        s = str(e)
        if "unauthorized_client" in s:
            return None, "gmail.compose not delegated to the service account"
        return None, f"{type(e).__name__}: {s[:160]}"


# ── report generation ───────────────────────────────────────────────────
def previous_week():
    today = datetime.now(ZoneInfo("Australia/Melbourne")).date()
    start = today - timedelta(days=today.weekday() + 7)
    return start.isoformat(), (start + timedelta(days=6)).isoformat()


def existing_report(client_name, since):
    db = sqlite3.connect(DB)
    row = db.execute("""select r.id, r.html_path, r.docx_path from reports r join clients c on c.id=r.client_id
                        where c.name=? and r.start_date=? and r.status in ('ready','delivered','approved')
                        and r.docx_path is not null order by r.id desc limit 1""", (client_name, since)).fetchone()
    return row if row and Path(row[2]).exists() and Path(row[1]).exists() else None


def generate(client_name, since, until):
    p = subprocess.run(["node", "generate_report.js", "--client", client_name, "--since", since,
                        "--until", until], cwd=BASE, capture_output=True, text=True, timeout=900)
    if "OUTPUT_PATH=" not in p.stdout:
        tail = (p.stdout + p.stderr).strip().splitlines()[-6:]
        raise RuntimeError("generator failed: " + " | ".join(tail))
    row = existing_report(client_name, since)
    if not row:
        raise RuntimeError("generator finished but report not registered in state.db")
    return row


def report_text(html_path):
    t = Path(html_path).read_text(errors="ignore")
    t = re.sub(r"<style.*?</style>", " ", t, flags=re.S)
    t = html.unescape(re.sub(r"<[^>]+>", " ", t))
    t = re.sub(r"\s+", " ", t)
    i = t.find("Executive Summary")
    return t[i:] if i >= 0 else t


# ── jev gate ────────────────────────────────────────────────────────────
def jev_gate(client_label, items, last_email):
    try:
        from jev_decision import decide, noul
    except Exception as e:
        return items, f"Jev unavailable: {e}"

    def one(it):
        state = (f"Weekly performance email from an ad agency owner (Will) to his client {client_label}.\n"
                 f"Candidate item for the email: {it['text']}\nCategory: {it['category']}\n"
                 f"Evidence: {it.get('evidence', '')}\nLast week's email body:\n{last_email[:900]}")
        out = decide(state=state, questions={
            "client_facing": noul("This item is suitable to mention to the client in a short weekly update "
                                  "(not internal ops, credentials, billing disputes, or agency-side mistakes)"),
            "grounded": noul("The item is directly supported by the evidence given"),
            "new": noul("This item adds something not already said in last week's email"),
        })
        a = {k: v.get("noul", 0) for k, v in out["answers"].items()}
        it["jev"] = a
        it["keep"] = a["client_facing"] >= 0.6 and a["grounded"] >= 0.6 and a["new"] >= 0.4
        return it

    try:
        with ThreadPoolExecutor(8) as ex:
            gated = list(ex.map(one, items))
        return gated, None
    except Exception as e:
        return items, f"Jev call failed: {str(e)[:200]}"


# ── validation ──────────────────────────────────────────────────────────
NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")


def norm(n):
    return n.replace(",", "").rstrip("0").rstrip(".") if "." in n else n.replace(",", "")


def validate(body, link, report, items_text, forbidden=()):
    errs = []
    for term in forbidden:
        if re.search(rf"\b{re.escape(term)}\b", body, re.I):
            errs.append(f"'{term}' belongs to a different client; remove it")
    core = body.replace(link, "")
    words = len(re.findall(r"[A-Za-z0-9$'’.-]+", core))
    if not 45 <= words <= 140:
        errs.append(f"body is {words} words; keep it 50-120")
    if not body.lstrip().startswith("Hey team"):
        errs.append("must open with 'Hey team,'")
    if not re.search(r"Cheers\s*,?\s*\n+\s*William\s*$", body.strip()):
        errs.append("must end with 'Cheers' then 'William' on its own line")
    if link not in body:
        errs.append("the report link must appear on its own line")
    if re.search(r"^\s*([-*•]|\d+\.)\s", body, re.M) or "#" in body:
        errs.append("no bullets, numbered lists or headers")
    if re.search(r"\battached\b", body, re.I):
        errs.append("do not say 'attached'; Will links the report")
    known = {norm(n) for n in NUM.findall(report + " " + items_text)}
    bad = [n for n in NUM.findall(core) if norm(n) not in known and float(norm(n) or 0) > 3]
    if bad:
        errs.append(f"these numbers are not in the report or evidence: {sorted(set(bad))}")
    return errs


# ── per client ──────────────────────────────────────────────────────────
VOICE_RULES = """You write Will Varney's weekly client performance email, exactly in his voice.
Shape: "Hey team," / one short line pointing to the report / the report link on its own line /
1-2 sentences on performance using real numbers / 2-4 sentences on the workstream: what we're working on,
anything waiting on their approval, what's coming next, and a straight answer to any open question they asked /
"Cheers" / "William".
Style: plain, direct, specific, forward-looking. Short sentences, commas instead of formal punctuation,
contractions. No bullet points, no headers, no emoji, no hype, no filler, no corporate phrasing.
Never say "attached" — the report is a link. Never invent facts, numbers, dates or promises. Use A$ only if the
client's examples do. 60-110 words excluding the link.
The report's "Recommended Next Steps" and "Opportunities" are automated suggestions, not work that is happening;
never present them as things we are doing. Only the workstream items are real actions.
Follow the client's reporting notes exactly (e.g. which regions a total covers)."""


def jev_check_draft(label, body, report, items_text, notes):
    """Per-sentence grounding check. A single holistic 'is everything supported'
    question scores accurate drafts ~0.4; per-claim questions discriminate."""
    try:
        from jev_decision import decide, noul
        sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", body)
                 if len(s.strip()) > 25 and "http" not in s]
        ctx = f"Report:\n{report[:3000]}\n\nWorkstream items:\n{items_text}\n\nClient notes:\n{notes[:2500]}"

        def one(s):
            out = decide(state=f"Client: {label}\nClaim from the draft email: {s}\n\n{ctx}", questions={
                "supported": noul("The claim is supported by the report, workstream items or notes, "
                                  "with any total attributed to the right regions/scope"),
                "real_action": noul("If the claim describes work being done, it comes from the workstream "
                                    "items or notes rather than the report's recommendations"),
            })
            return s, {k: v.get("noul", 0) for k, v in out["answers"].items()}

        with ThreadPoolExecutor(6) as ex:
            scored = list(ex.map(one, sents))
        errs = [f"this sentence isn't supported by the report/notes, fix or drop it: \"{s}\""
                for s, a in scored if a["supported"] < 0.55]
        errs += [f"this sentence presents a report recommendation as work in progress: \"{s}\""
                 for s, a in scored if a["real_action"] < 0.5]
        return errs, {s[:60]: a for s, a in scored}
    except Exception as e:
        return [], {"error": str(e)[:160]}


def run_client(c, since, until, reuse):
    slug, label = c["slug"], c["name"]
    res = {"client": label, "slug": slug, "status": "BLOCKED", "flags": []}
    row = existing_report(label, since) if reuse else None
    if not row:
        row = generate(label, since, until)
    rid, html_path, docx_path = row
    res["report_id"] = rid
    rtext = report_text(html_path)
    res["headline"] = rtext[len("Executive Summary"):][:260].strip()

    fname = f"{label.replace(' ', '_')}_{since}_{until}.docx"
    link = drive_upload(Path(docx_path), c["drive_folder"], fname)
    res["link"] = link

    q = " OR ".join(f"from:{d} OR to:{d}" for d in c["email_domains"])
    # Box Divvy's automations relay every lead SMS into the same mailbox, and
    # those relays now outnumber the real client thread (17 of the 20 newest
    # on 2026-10-25). Left in, they push the previous report email out of the
    # window and drown the workstream evidence. Exclude the relays, and fall
    # back to the raw query if the filtered one ever returns nothing.
    thread = gmail_messages(f'({q}) newer_than:21d -subject:"SMS reply"', 20)
    if not thread:
        thread = gmail_messages(f"({q}) newer_than:21d", 20)
    last_sent = next((m for m in thread if SUBJECT_USER in m["from"]
                      and re.search(r"report", m["subject"], re.I)), None)
    last_email = last_sent["body"] if last_sent else ""
    workstream_md = (BASE / "clients" / f"{slug}.md")
    notes = workstream_md.read_text() if workstream_md.exists() else ""

    evidence = "\n\n".join(f"[{m['id']}] {m['date'][:16]} FROM {m['from']} | {m['subject']}\n{m['body'][:700]}"
                           for m in thread)
    items = llm_json(
        "You extract the live workstream for one agency client from real emails. Output a JSON array of "
        "objects {text, category, evidence, source_id}. category is one of: in_flight, awaiting_client, "
        "coming_next, open_client_question, ops_flag. text is one plain sentence. evidence quotes the source. "
        "Use only facts in the emails and notes. Mark internal problems (broken campaigns, credentials, "
        "billing, agency mistakes, software bugs they haven't raised) as ops_flag. Skip anything resolved. "
        "At most 10 items; keep evidence under 25 words.",
        f"Client: {label}\nToday: {date.today()}\n\nWorkstream notes (may be stale):\n{notes}\n\nEmails, newest first:\n{evidence}",
        4000)
    items = [i for i in items if isinstance(i, dict) and i.get("text")]
    res["flags"] += [i["text"] for i in items if i.get("category") == "ops_flag"]
    candidates = [i for i in items if i.get("category") != "ops_flag"]
    gated, jev_err = jev_gate(label, candidates, last_email)
    res["jev"] = jev_err or "ran"
    keep = [i for i in gated if i.get("keep", True)]
    res["items_kept"] = [i["text"] for i in keep]
    res["items_dropped"] = [i["text"] for i in gated if not i.get("keep", True)]

    examples = []
    for mid in c.get("voice_examples", [])[:4]:
        try:
            m = gmail_message(mid)
            examples.append(f"Subject: {m['subject']}\n{m['body'][:900]}")
        except Exception:
            pass

    items_text = "\n".join(f"- ({i['category']}) {i['text']}  [evidence: {i.get('evidence', '')[:200]}]" for i in keep)
    user = (f"Will's real past emails to this client:\n\n" + "\n\n---\n\n".join(examples) +
            f"\n\n=== THIS WEEK ===\nClient: {label}\nReport window: {since} to {until}\nReport link: {link}\n"
            f"Client notes (follow the reporting notes; never use the ops flags):\n{notes}\n\n"
            f"Report text (source of truth for numbers):\n{rtext[:5000]}\n\nWorkstream items (use the most "
            f"important 2-4, answer any open_client_question):\n{items_text}\n\n"
            'Return JSON {"subject": ..., "body": ...}. Subject follows Will\'s real subjects '
            '(e.g. "Performance report", "Latest report", "Latest report and <topic>").')
    forbidden = c.get("forbidden_terms", [])
    draft, errs, res["jev_draft"] = None, ["not attempted"], {}
    for _ in range(4):
        draft = llm_json(VOICE_RULES, user, 1200)
        errs = validate(draft["body"], link, rtext, items_text + " " + notes, forbidden)
        if not errs:
            errs, res["jev_draft"] = jev_check_draft(label, draft["body"], rtext, items_text, notes)
        if not errs:
            break
        user += "\n\nYour last draft failed these checks, fix them:\n- " + "\n- ".join(errs) + \
                f"\n\nLast draft:\n{draft['body']}"
    res["subject"], res["body"], res["validation"] = draft["subject"], draft["body"].strip(), errs or "pass"

    to = c["recipients"]
    cc = c.get("cc_when_mentioned", {})
    cc_list = [addr for name, addr in cc.items() if re.search(rf"\b{name}\b", res["body"])]
    msg = EmailMessage()
    msg["To"], msg["Subject"] = ", ".join(to), res["subject"]
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    msg.set_content(res["body"])
    chart = Path(docx_path).with_name(Path(docx_path).stem.replace("_2", "_chart_2", 1) + ".png")
    if chart.exists():
        body_html = "<br>".join(html.escape(l) for l in res["body"].splitlines())
        body_html = body_html.replace(html.escape(link), f'<a href="{link}">{html.escape(link)}</a>')
        msg.add_alternative(f'<div>{body_html}</div><br><img src="cid:chart" width="600">', subtype="html")
        msg.get_payload()[1].add_related(chart.read_bytes(), "image", "png", cid="<chart>")
    res["to"], res["cc"] = to, cc_list

    outdir = BASE / "email-drafts" / date.today().isoformat()
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / f"{slug}.eml").write_bytes(msg.as_bytes())
    (outdir / f"{slug}.txt").write_text(f"To: {', '.join(to)}\n" + (f"Cc: {', '.join(cc_list)}\n" if cc_list else "")
                                        + f"Subject: {res['subject']}\n\n{res['body']}\n")
    if errs and errs != "pass":
        res["draft"] = "not created: failed validation"
    else:
        draft_id, why = gmail_draft(msg)
        res["draft"] = f"Gmail draft {draft_id}" if draft_id else f"local only ({why})"
    res["files"] = str(outdir / f"{slug}.eml")
    res["status"] = "READY" if res["validation"] == "pass" else "CHECK"

    (BASE / "clients" / f"{slug}.auto.json").write_text(json.dumps(
        {"updated": datetime.now().isoformat(timespec="minutes"), "window": [since, until],
         "items": gated, "ops_flags": res["flags"]}, indent=1))
    return res


def packet(results, since, until):
    L = [f"SEND REPORTS TODAY · {since} → {until}", ""]
    for r in results:
        L.append(f"◆ {r['client']} — {r['status']}" + (f" · report {r['report_id']}" if r.get("report_id") else ""))
        if r.get("error"):
            L.append(f"  error: {r['error']}")
            continue
        L.append(f"  draft: {r['draft']}")
        L.append(f"  to: {', '.join(r['to'])}" + (f" · cc {', '.join(r['cc'])}" if r["cc"] else ""))
        L.append(f"  Jev gate: {r['jev']} · kept {len(r['items_kept'])}, dropped {len(r['items_dropped'])}")
        if r["validation"] != "pass":
            L.append(f"  validation: {'; '.join(r['validation'])}")
        L += ["", f"Subject: {r['subject']}", "", r["body"], ""]
        if r["flags"]:
            L.append("  for you, not the client:")
            L += [f"  ↳ {f}" for f in r["flags"][:6]]
        L.append("")
    L.append("Nothing has been sent.")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--client"); ap.add_argument("--since"); ap.add_argument("--until")
    ap.add_argument("--reuse", action="store_true")
    a = ap.parse_args()
    since, until = (a.since, a.until) if a.since else previous_week()
    clients = [c for c in CFG["clients"] if c.get("active") and c.get("slug")
               and (not a.client or c["slug"] == a.client)]
    results: list = [None] * len(clients)

    def work(ix):
        c = clients[ix]
        try:
            results[ix] = run_client(c, since, until, a.reuse)
        except Exception as e:
            results[ix] = {"client": c["name"], "status": "BLOCKED", "error": f"{type(e).__name__}: {str(e)[:300]}"}

    with ThreadPoolExecutor(len(clients) or 1) as ex:
        list(ex.map(work, range(len(clients))))
    out = packet(results, since, until)
    logdir = BASE / "email-drafts" / date.today().isoformat()
    logdir.mkdir(parents=True, exist_ok=True)
    (logdir / "run.json").write_text(json.dumps(results, indent=1, default=str))
    print(out)


if __name__ == "__main__":
    main()
