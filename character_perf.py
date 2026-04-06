#!/usr/bin/env python3
"""
Agency Client — Character Type Performance Tracker (Closed Loop)
Closed-loop: UGC character types → Meta ad performance → next brief recommendations

Key insight: Ad-level insights often return empty for paused/historical ads.
Strategy: Use adset naming + campaign tracking to build performance history over time.

For new ads: include [char:xxx] in the ad name for direct attribution.
For existing: adset name carries audience/format signal.

Usage:
  python3 character_perf.py                          # Score all clients (last 7 days)
  python3 character_perf.py --client "NeedleFree"   # Single client
  python3 character_perf.py --recommend             # Print brief recommendations
  python3 character_perf.py --tag "gym-bro"         # Show how to name ads with this tag
"""

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "state.db"
HISTORY_DIR = BASE_DIR / "character_history"
CONFIG_PATH = BASE_DIR / "config.json"

HISTORY_DIR.mkdir(exist_ok=True)

# Character type → ad name patterns
# These map keywords in adset/ad names to character types
CHARACTER_MAPPING = {
    "gym-bro": ["gym bro", "gym-bro", "gym bro ", "bro "],
    "bodybuilder": ["bodybuild", " physique"],
    "mma-fighter": ["mma ", "mma-", "fighter", "mmafighter"],
    "strongman": ["strongman", "strong man"],
    "olympic-lifter": ["olympic", "weightlift", "snatch", "clean & jerk"],
    "crossfit": ["crossfit", "cross fit"],
    "fitness-couple": ["couple", "duo", "together"],
    "coach": ["coach", "trainer"],
    "trt": ["trt", "testosterone"],
    "transformation": ["transformation", "transformation"],
    "before-after": ["before", "bfaf"],
    "natural": ["natural", "natty"],
    "plyometrics": ["plyo", "jump"],
    "powerlifting": ["powerlift", "squat", "deadlift"],
}

EXPLICIT_CHAR_RE = re.compile(r"\[char:([^\]]+)\]")


def load_config() -> dict:
    with open(CONFIG_PATH) as f:
        return json.load(f)


def get_history_path(client_name: str) -> Path:
    safe = client_name.replace(" ", "_").replace("(", "").replace(")", "")
    return HISTORY_DIR / f"{safe}.json"


def load_history(client_name: str) -> dict:
    path = get_history_path(client_name)
    if path.exists():
        return json.load(open(path))
    return {}


def save_history(client_name: str, history: dict):
    path = get_history_path(client_name)
    json.dump(history, open(path, 'w'), indent=2)


def extract_character_from_name(name: str) -> str:
    """Extract character type from ad or adset name."""
    name_lower = name.lower()
    
    m = EXPLICIT_CHAR_RE.search(name)
    if m:
        return m.group(1)
    
    for char_type, keywords in CHARACTER_MAPPING.items():
        for kw in keywords:
            if kw in name_lower:
                return char_type
    
    return "generic"


def fetch_adsets_performance(account_id: str, start_date: str, end_date: str) -> List[dict]:
    """Fetch adset-level performance breakdown."""
    sys.path.insert(0, str(BASE_DIR))
    from data_fetcher import pipeboard_call, parse_insights_json, safe_float, safe_int, extract_conversions
    
    # Get adsets
    result = pipeboard_call("get_adsets", {
        "account_id": account_id,
        "fields": "name,id,campaign_id,status"
    })
    adsets_raw = parse_insights_json(result)
    
    adsets = []
    for a in adsets_raw:
        adset_id = a.get("id", a.get("adset_id", ""))
        adset_name = a.get("name", "")
        campaign_id = a.get("campaign_id", "")
        status = a.get("status", "")
        
        insight_result = pipeboard_call("get_insights", {
            "object_id": adset_id,
            "time_range": {"since": start_date, "until": end_date},
            "fields": "spend,impressions,clicks,ctr,actions,cost_per_action_type",
            "level": "adset"
        })
        insight_rows = parse_insights_json(insight_result)
        if not insight_rows:
            continue
        
        row = insight_rows[0]
        spend = safe_float(row.get("spend", 0))
        if spend == 0:
            continue
        
        impressions = safe_int(row.get("impressions", 0))
        clicks = safe_int(row.get("clicks", 0))
        
        conversions = 0
        actions = row.get("actions", [])
        if isinstance(actions, list):
            for act in actions:
                if act.get("action_type") in ("purchase", "lead", "subscribe", "complete_registration"):
                    conversions += int(float(act.get("value", 0)))
        
        cpa = spend / conversions if conversions > 0 else None
        char_type = extract_character_from_name(adset_name)
        
        adsets.append({
            "adset_id": adset_id,
            "adset_name": adset_name,
            "character_type": char_type,
            "campaign_id": campaign_id,
            "status": status,
            "spend": round(spend, 2),
            "impressions": impressions,
            "clicks": clicks,
            "conversions": conversions,
            "cpa": round(cpa, 2) if cpa else None,
            "ctr": round(clicks / max(impressions, 1) * 100, 2),
        })
    
    return adsets


def fetch_campaign_performance(account_id: str, start_date: str, end_date: str) -> List[dict]:
    """Fetch campaign-level performance."""
    sys.path.insert(0, str(BASE_DIR))
    from data_fetcher import get_campaign_insights
    
    return get_campaign_insights(account_id, start_date, end_date)


def score_by_character(adsets: List[dict]) -> Dict[str, dict]:
    """Aggregate performance by character type."""
    chars: Dict[str, dict] = {}
    
    for a in adsets:
        ct = a["character_type"]
        if ct not in chars:
            chars[ct] = {
                "character_type": ct,
                "total_spend": 0,
                "total_conversions": 0,
                "total_impressions": 0,
                "total_clicks": 0,
                "adset_count": 0,
                "adsets": [],
                "cpas": [],
            }
        
        ch = chars[ct]
        ch["total_spend"] += a["spend"]
        ch["total_conversions"] += a["conversions"]
        ch["total_impressions"] += a["impressions"]
        ch["total_clicks"] += a["clicks"]
        ch["adset_count"] += 1
        ch["adsets"].append({"name": a["adset_name"], "id": a["adset_id"]})
        if a["cpa"]:
            ch["cpas"].append(a["cpa"])
    
    for ct, ch in chars.items():
        ch["avg_cpa"] = round(sum(ch["cpas"]) / len(ch["cpas"]), 2) if ch["cpas"] else None
        ch["blended_cpa"] = round(ch["total_spend"] / ch["total_conversions"], 2) if ch["total_conversions"] > 0 else None
        ch["ctr"] = round(ch["total_clicks"] / max(ch["total_impressions"], 1) * 100, 2)
        ch["conv_rate"] = round(ch["total_conversions"] / max(ch["total_clicks"], 1) * 100, 2)
        del ch["adsets"]
        del ch["cpas"]
    
    return chars


def generate_recommendations(scored: Dict[str, dict], client_name: str, days: int) -> str:
    """Generate markdown recommendations for next creative brief."""
    sorted_chars = sorted(scored.values(), key=lambda x: (-x["total_conversions"], x.get("blended_cpa") or 999))
    
    lines = [
        f"## {client_name} — Creative Performance Recommendations",
        f"_Scored over last {days} days | Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}_\n",
    ]
    
    winners = [c for c in sorted_chars if c["total_conversions"] > 0]
    no_conv = [c for c in sorted_chars if c["total_conversions"] == 0 and c["total_spend"] > 0]
    no_spend = [c for c in sorted_chars if c["total_spend"] == 0]
    
    if winners:
        lines.append("### Top Performers\n")
        lines.append("| Character Type | Adsets | Spend | Conv | CPA | CTR |")
        lines.append("|---|---|---|---|---|---|")
        for c in winners[:6]:
            cpa_str = f"${c['blended_cpa']:.2f}" if c.get("blended_cpa") else "N/A"
            lines.append(f"| `{c['character_type']}` | {c['adset_count']} | ${c['total_spend']:.0f} | {c['total_conversions']} | {cpa_str} | {c['ctr']:.1f}% |")
    
    if no_conv and scored:
        lines.append("\n### Pause or Revise\n")
        for c in no_conv:
            lines.append(f"- `{c['character_type']}` — ${c['total_spend']:.0f} spend, 0 conversions. **Recommend pausing** or changing creative angle")
    
    lines.append("\n### Next Brief Directives\n")
    
    if winners:
        top = winners[0]
        cpa_str = f"${top.get('blended_cpa', 'N/A'):.2f}" if top.get('blended_cpa') else 'N/A'
        lines.append(f"1. **Lead with `{top['character_type']}`** — best converting at {cpa_str}/conversion ({top['total_conversions']} conv from ${top['total_spend']:.0f} spend)")
        
        if len(winners) > 1:
            second = winners[1]
            lines.append(f"2. **Test `{second['character_type']}`** — {second['total_conversions']} conv, ${second.get('blended_cpa', 'N/A'):.2f}/CPA")
    
    # Build character type priority list
    priority = [c["character_type"] for c in sorted_chars if c["character_type"] != "generic"][:5]
    if priority:
        lines.append(f"\n3. **Character priority order:** `{'` → `'.join(priority)}`")
    
    if no_conv:
        avoid = [c["character_type"] for c in no_conv if c["character_type"] != "generic"]
        if avoid:
            lines.append(f"\n4. **Avoid or test differently:** `{'`, `'.join(avoid)}`")
    
    return "\n".join(lines)


def store_snapshot(client_name: str, scored: dict, start: str, end: str):
    """Store a performance snapshot in history."""
    history = load_history(client_name)
    
    if "snapshots" not in history:
        history["snapshots"] = []
    
    snapshot = {
        "period_start": start,
        "period_end": end,
        "generated_at": datetime.now().isoformat(),
        "data": scored,
    }
    history["snapshots"].append(snapshot)
    
    # Keep last 26 weeks
    if len(history["snapshots"]) > 26:
        history["snapshots"] = history["snapshots"][-26:]
    
    save_history(client_name, history)


def get_trend(client_name: str, character_type: str, weeks: int = 4) -> dict:
    """Get performance trend for a character type over N weeks."""
    history = load_history(client_name)
    snapshots = history.get("snapshots", [])
    
    recent = [s for s in snapshots[-weeks:] if s.get("data", {}).get(character_type)]
    
    if not recent:
        return {"trend": "insufficient_data", "weeks": 0}
    
    convs = [s["data"][character_type]["total_conversions"] for s in recent]
    spends = [s["data"][character_type]["total_spend"] for s in recent]
    
    return {
        "weeks": len(recent),
        "avg_conversions": round(sum(convs) / len(convs), 1),
        "avg_spend": round(sum(spends) / len(spends), 1),
        "trend": "improving" if convs[-1] > convs[0] else "declining" if convs[-1] < convs[0] else "stable",
    }


def run_client(client_name: str, account_id: str, days: int) -> dict:
    """Score one client's adsets by character type."""
    end_date = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    
    print(f"\n[{client_name}] {start_date} → {end_date}")
    
    adsets = fetch_adsets_performance(account_id, start_date, end_date)
    print(f"[{client_name}] {len(adsets)} adsets with spend")
    
    if not adsets:
        # Fallback to campaign-level
        campaigns = fetch_campaign_performance(account_id, start_date, end_date)
        if campaigns:
            total_spend = sum(c["spend"] for c in campaigns)
            total_conv = sum(c["conversions"] for c in campaigns)
            print(f"[{client_name}] No adset data — campaign total: ${total_spend:.2f} spend, {total_conv} conv")
            return {}
        print(f"[{client_name}] No performance data available")
        return {}
    
    scored = score_by_character(adsets)
    
    print(f"\n[{client_name}] Performance by Character Type:")
    print(f"{'Type':<18} {'Adsets':>6} {'Spend':>8} {'Conv':>5} {'CPA':>8} {'CTR':>6}")
    print("-" * 55)
    
    sorted_chars = sorted(scored.values(), key=lambda x: -x["total_conversions"])
    for ch in sorted_chars:
        cpa = f"${ch['blended_cpa']:.2f}" if ch.get("blended_cpa") else "   N/A  "
        print(f"{ch['character_type']:<18} {ch['adset_count']:>6} ${ch['total_spend']:>7.0f} {ch['total_conversions']:>5} {cpa:>8} {ch['ctr']:>5.1f}%")
    
    store_snapshot(client_name, scored, start_date, end_date)
    
    recs = generate_recommendations(scored, client_name, days)
    print(f"\n{recs}")
    
    return scored


def main():
    parser = argparse.ArgumentParser(description="Agency Client — Character Type Performance Tracker")
    parser.add_argument("--client", help="Client name (exact match)")
    parser.add_argument("--days", type=int, default=7, help="Days to look back (default: 7)")
    parser.add_argument("--recommend", action="store_true", help="Show recommendations only")
    parser.add_argument("--trend", help="Show trend for character type")
    parser.add_argument("--output", help="Save JSON output to file")
    args = parser.parse_args()
    
    config = load_config()
    results = {}
    
    clients = config["clients"]
    if args.client:
        clients = [c for c in clients if args.client.lower() in c["name"].lower()]
        if not clients:
            print(f"Client '{args.client}' not found")
            sys.exit(1)
    
    for client in clients:
        name = client["name"]
        account = client["account_id"]
        
        try:
            scored = run_client(name, account, args.days)
            results[name] = scored
        except Exception as e:
            print(f"[{name}] ERROR: {e}")
            import traceback
            traceback.print_exc()
    
    if args.output:
        Path(args.output).write_text(json.dumps(results, indent=2))
        print(f"\nSaved to {args.output}")
    
    if args.trend:
        for client in clients:
            trend = get_trend(client["name"], args.trend)
            print(f"\n[{client['name']}] {args.trend}: {trend}")


if __name__ == "__main__":
    main()
