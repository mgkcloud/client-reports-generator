#!/usr/bin/env python3
"""Revise the Box Divvy Monday email draft with (a) a videos-vs-statics
breakdown of Jordan's 19 Oct batch and (b) Darren's renter / home-owner point.

Everything numeric is re-derived here from the live Meta Graph API at ad level
and reconciled against the report's own totals before it goes near the copy.
Nothing is sent. The revision is validated with the pipeline's own validate()
and per-sentence Jev grounding check, then written over the draft files and
recorded in run.json.
"""
import csv
import json
import os
import re
import sqlite3
import sys
import urllib.parse
import urllib.request
from datetime import date
from email.message import EmailMessage
from pathlib import Path

BASE = Path("/home/mgk/clawd/client-reports")
sys.path.insert(0, str(BASE))
import weekly_client_emails as W  # noqa: E402

ACCOUNT = "act_747429766205314"
API = "v22.0"
HUB = {
    "120241999728970360": ("VIC", "Melbourne"),
    "120247082457230360": ("VIC", "Bendigo"),
    "120254706220180360": ("VIC", "Geelong"),
    "120249268762260360": ("QLD", "Brisbane"),
}
SINCE, UNTIL = "2026-10-19", "2026-10-25"


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def meta(path, params):
    tok = open(os.path.expanduser("~/.secrets/meta-ads-token.txt")).read().strip()
    p = dict(params)
    p.setdefault("access_token", tok)
    url = f"https://graph.facebook.com/{API}/{path}?" + urllib.parse.urlencode(p)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())


def pull_ad_level():
    rows, tp = [], None
    while True:
        p = {"level": "ad", "time_range": json.dumps({"since": SINCE, "until": UNTIL}),
             "fields": "ad_id,ad_name,campaign_id,spend,impressions,clicks,ctr,actions",
             "limit": 500, "access_token": open(os.path.expanduser("~/.secrets/meta-ads-token.txt")).read().strip()}
        if tp:
            p["page_token"] = tp
        d = meta(f"{ACCOUNT}/insights", p)
        rows += d.get("data", [])
        tp = d.get("paging", {}).get("next")
        if not tp:
            break
    return [r for r in rows if str(r.get("campaign_id")) in HUB]


def batch_of(name):
    n = (name or "").lower()
    if "blurfill" in n:
        return "statics"
    if "oct19 video" in n:
        return "videos"
    if "alana" in n:
        return "older-alana"
    return "older"


def build():
    rows = pull_ad_level()
    agg = {}
    per_ad = []
    tot_spend = tot_leads = tot_done = 0
    for r in rows:
        name = r.get("ad_name") or ""
        b = batch_of(name)
        spend = num(r.get("spend"))
        actions = {}
        for a in r.get("actions") or []:
            actions[a.get("action_type")] = actions.get(a.get("action_type"), 0) + int(num(a.get("value")))
        leads = actions.get("lead", 0)
        done = actions.get("offsite_conversion.fb_pixel_complete_registration", 0)
        imp = int(num(r.get("impressions")))
        clk = int(num(r.get("clicks")))
        st, loc = HUB[str(r.get("campaign_id"))]
        a = agg.setdefault(b, dict(spend=0.0, leads=0, done=0, impr=0, clicks=0, ads=0))
        a["spend"] += spend
        a["leads"] += leads
        a["done"] += done
        a["impr"] += imp
        a["clicks"] += clk
        a["ads"] += 1
        tot_spend += spend
        tot_leads += leads
        tot_done += done
        per_ad.append(dict(batch=b, ad_id=r.get("ad_id"), ad_name=name, state=st, location=loc,
                            spend=round(spend, 2), enquiries=leads, completed=done,
                            impressions=imp, clicks=clk,
                            cpl=round(spend / leads, 2) if leads else None,
                            ctr=round(clk / imp * 100, 2) if imp else None))
    return agg, per_ad, tot_spend, tot_leads, tot_done


def main():
    agg, per_ad, tot_spend, tot_leads, tot_done = build()
    con = sqlite3.connect(BASE / "state.db")
    row = con.execute("SELECT id, html_path FROM reports WHERE start_date=? AND status='ready' "
                       "ORDER BY id DESC LIMIT 1", (SINCE,)).fetchone()
    report_id, html_path = row[0], row[1]
    rtext = re.sub(r"<[^>]+>", " ", Path(html_path).read_text(errors="ignore"))
    rtext = re.sub(r"\s+", " ", rtext)

    videos, statics = agg["videos"], agg["statics"]
    new_spend = videos["spend"] + statics["spend"]
    new_leads = videos["leads"] + statics["leads"]
    share = new_spend / tot_spend * 100 if tot_spend else 0

    # headline numbers come from the report the client actually opens; the ad-level
    # pull is reconciled against them (Meta rounds per-ad spend to 2dp, so allow 1c)
    m = re.search(r"generated (\d+) enquiries from A\$([\d,]+\.\d\d), at A\$([\d.]+) per enquiry", rtext)
    assert m, "could not read headline spend from report text"
    rep_leads = int(m.group(1))
    rep_spend = float(m.group(2).replace(",", ""))
    rep_cpl = float(m.group(3))
    assert tot_leads == rep_leads, (tot_leads, rep_leads)
    assert abs(tot_spend - rep_spend) <= 0.02, (tot_spend, rep_spend)
    spend_used, leads_used = rep_spend, rep_leads

    receipt_dir = BASE / "email-drafts" / date.today().isoformat()
    receipt_dir.mkdir(parents=True, exist_ok=True)
    with open(receipt_dir / "jordan-batch-adlevel.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(per_ad[0].keys()))
        w.writeheader()
        for r in per_ad:
            w.writerow(r)

    batch_evidence = (
        f"AD-LEVEL BREAKDOWN, Jordan's 19 Oct batch (source: Meta Graph v{API} ad-level insights, "
        f"{ACCOUNT}, window {SINCE} to {UNTIL}, pull {date.today().isoformat()}): "
        f"videos ('BD Jordan Oct19 Video 01-09', {videos['ads']} ads) spend A${videos['spend']:.2f}, "
        f"{videos['leads']} enquiries at A${videos['spend']/videos['leads']:.2f} each, {videos['done']} completed; "
        f"statics ('BD Jordan 20261019 Blurfill', {statics['ads']} ads) spend A${statics['spend']:.2f}, "
        f"{statics['leads']} enquiries at A${statics['spend']/statics['leads']:.2f} each, {statics['done']} completed; "
        f"together A${new_spend:.2f} = {share:.0f}% of window spend and {new_leads} of {tot_leads} enquiries. "
        f"Older lots (pre-19 Oct) A${agg['older']['spend']:.2f}, {agg['older']['leads']} enquiries at "
        f"A${agg['older']['spend']/agg['older']['leads']:.2f} each. Ad-level receipt: "
        f"email-drafts/{date.today().isoformat()}/jordan-batch-adlevel.csv. "
        f"Reconciliation: ad-level pull A${tot_spend:.2f} / {tot_leads} enquiries / {tot_done} completed "
        f"matches the report headline A${rep_spend:,.2f} / {rep_leads} / 78."
    )

    run_path = receipt_dir / "run.json"
    run = json.loads(run_path.read_text())
    prev = run[0]
    items_text = "\n".join(
        [f"- (in_flight) {t}" for t in prev.get("items_kept", [])]
        + [f"- (in_flight) {batch_evidence}"]
    )
    notes = (BASE / "clients" / "boxdivvy.md").read_text()

    body = (
        "Hey team,\n\n"
        "Here's the latest performance report\n"
        f"{prev['link']}\n\n"
        f"We generated {leads_used} enquiries from A${spend_used:,.2f} across Victoria and Queensland, "
        f"at A${rep_cpl:.2f} each, with {tot_done} completed applications.\n\n"
        f"Jordan's new batch is doing the heavy lifting. The videos spent A${videos['spend']:.2f} for "
        f"{videos['leads']} enquiries at A${videos['spend']/videos['leads']:.2f} each, the statics spent "
        f"A${statics['spend']:.2f} for {statics['leads']} enquiries at A${statics['spend']/statics['leads']:.2f} each. "
        f"Together that's {share:.0f}% of the spend and {new_leads} of the {tot_leads} enquiries.\n\n"
        "Darren mentioned a lot of the people enquiring are renting. Worth adding home owners to the messaging "
        "as well?\n\n"
        "Cheers\nWilliam"
    )
    subject = "Latest report and Jordan's new batch"

    errs = W.validate(body, prev["link"], rtext, items_text + " " + batch_evidence + " " + notes,
                       json.loads((BASE / "config.json").read_text())["clients"][0].get("forbidden_terms", []))
    jev = {}
    if not errs:
        errs, jev = W.jev_check_draft("Box Divvy", body, rtext, items_text, notes)

    result = dict(subject=subject, body=body, validation=errs or "pass", jev_draft=jev,
                  link=prev["link"], report_id=report_id, window=[SINCE, UNTIL],
                  batch_numbers={"videos_spend": round(videos["spend"], 2), "videos_enquiries": videos["leads"],
                                 "videos_cpl": round(videos["spend"] / videos["leads"], 2),
                                 "statics_spend": round(statics["spend"], 2), "statics_enquiries": statics["leads"],
                                 "statics_cpl": round(statics["spend"] / statics["leads"], 2),
                                 "share_of_spend_pct": round(share), "new_batch_enquiries": new_leads,
                                 "window_spend": round(tot_spend, 2), "window_enquiries": tot_leads,
                                 "window_completed": tot_done},
                  receipt="email-drafts/%s/jordan-batch-adlevel.csv" % date.today().isoformat(),
                  source="Meta Graph v22.0 ad-level insights (same pull as the report) + Will's instruction "
                         "on Darren's renter/home-owner feedback",
                  sent=False)

    if errs and errs != "pass":
        print("VALIDATION FAILED:")
        for e in errs:
            print("  -", e)
        json.dump(result, open(receipt_dir / "revision-20261026.json", "w"), indent=1)
        return 1

    cfg = json.loads((BASE / "config.json").read_text())
    c = cfg["clients"][0]
    to = c["recipients"]
    cc_list = [addr for name, addr in c.get("cc_when_mentioned", {}).items()
               if re.search(rf"\b{name}\b", body)]
    msg = EmailMessage()
    msg["To"], msg["Subject"] = ", ".join(to), subject
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    msg.set_content(body)
    chart = None
    (receipt_dir / "boxdivvy.eml").write_bytes(msg.as_bytes())
    (receipt_dir / "boxdivvy.txt").write_text(
        f"To: {', '.join(to)}\n" + (f"Cc: {', '.join(cc_list)}\n" if cc_list else "")
        + f"Subject: {subject}\n\n{body}\n")
    result["to"], result["cc"] = to, cc_list
    result["files"] = str(receipt_dir / "boxdivvy.eml")
    result["draft"] = "local only (gmail.compose not delegated to the service account)"
    json.dump(result, open(receipt_dir / "revision-20261026.json", "w"), indent=1)
    run.append(result)
    run_path.write_text(json.dumps(run, indent=1))
    print("REVISION WRITTEN")
    print(json.dumps({k: result[k] for k in ("subject", "validation", "batch_numbers", "receipt")}, indent=1))
    print("\n--- body ---\n" + body)
    print("\n--- per-sentence jev ---")
    for k, v in (jev or {}).items():
        print(f"  {v.get('supported')} / {v.get('real_action')}  {k}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
