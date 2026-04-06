"""
Pipeboard Meta Ads MCP Data Fetcher
Fetches campaign/adset/ad insights via Pipeboard's JSON-RPC 2.0 API.
"""

import json
import os
import subprocess
import time
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).parent / "config.json"


def load_config() -> dict:
    with open(CONFIG_PATH) as f:
        return json.load(f)


def get_pipeboard_token() -> str:
    config = load_config()
    token_file = os.path.expanduser(config["pipeboard_token_file"])
    with open(token_file) as f:
        return f.read().strip()


def pipeboard_call(tool_name: str, arguments: dict, retries: int = 3, delay: float = 5.0) -> dict:
    """
    Make a JSON-RPC 2.0 call to Pipeboard MCP endpoint.
    Returns the result dict or raises on error.
    """
    config = load_config()
    endpoint = config.get("pipeboard_endpoint", "https://mcp.pipeboard.co/meta-ads-mcp")
    token = get_pipeboard_token()

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments
        }
    }

    for attempt in range(1, retries + 1):
        try:
            logger.info(f"Pipeboard call: {tool_name}({json.dumps(arguments)}) [attempt {attempt}]")
            result = subprocess.run(
                [
                    "curl", "-s", "-X", "POST", endpoint,
                    "-H", f"Authorization: Bearer {token}",
                    "-H", "Content-Type: application/json",
                    "-d", json.dumps(payload),
                    "--max-time", "60"
                ],
                capture_output=True, text=True, timeout=90
            )

            if result.returncode != 0:
                raise RuntimeError(f"curl failed (rc={result.returncode}): {result.stderr}")

            response = json.loads(result.stdout)

            if "error" in response:
                error = response["error"]
                raise RuntimeError(f"Pipeboard error {error.get('code', '?')}: {error.get('message', str(error))}")

            # The result is in response["result"] — which contains "content" array
            res = response.get("result", response)
            logger.info(f"Pipeboard response OK for {tool_name}")
            return res

        except (RuntimeError, json.JSONDecodeError, subprocess.TimeoutExpired) as e:
            logger.warning(f"Pipeboard call failed (attempt {attempt}/{retries}): {e}")
            if attempt < retries:
                time.sleep(delay * attempt)
            else:
                raise


def extract_content_text(result: dict) -> str:
    """Extract text content from MCP tool result."""
    if isinstance(result, dict) and "content" in result:
        contents = result["content"]
        if isinstance(contents, list):
            texts = [c.get("text", "") for c in contents if c.get("type") == "text"]
            return "\n".join(texts)
    return json.dumps(result)


def parse_insights_json(result: dict) -> List[dict]:
    """Parse the insights response into a list of data rows."""
    text = extract_content_text(result)
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            if "data" in data:
                return data["data"]
            return [data]
    except json.JSONDecodeError:
        logger.warning(f"Could not parse insights JSON, raw text: {text[:500]}")
        return []


def compute_date_range(preset: str = "last_7d") -> Tuple[str, str]:
    """Compute date range strings. Returns (start_date, end_date) in YYYY-MM-DD."""
    today = datetime.now()
    if preset == "last_7d":
        end = today - timedelta(days=1)  # yesterday
        start = end - timedelta(days=6)
    elif preset == "last_14d":
        end = today - timedelta(days=1)
        start = end - timedelta(days=13)
    elif preset == "last_30d":
        end = today - timedelta(days=1)
        start = end - timedelta(days=29)
    else:
        end = today - timedelta(days=1)
        start = end - timedelta(days=6)
    return start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")


def get_previous_period_range(start_date: str, end_date: str) -> Tuple[str, str]:
    """Get the previous period of the same length for WoW comparison."""
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    duration = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=duration - 1)
    return prev_start.strftime("%Y-%m-%d"), prev_end.strftime("%Y-%m-%d")


# ─── Main Data Fetching Functions ──────────────────────────────────────

def get_account_overview(account_id: str, start_date: str, end_date: str) -> dict:
    """
    Fetch account-level aggregate metrics for the given date range.
    Returns: {spend, impressions, reach, clicks, cpm, cpc, ctr, conversions, cost_per_conversion, ...}
    """
    result = pipeboard_call("get_insights", {
        "object_id": account_id,
        "time_range": {"since": start_date, "until": end_date},
        "fields": "spend,impressions,reach,clicks,cpm,cpc,ctr,actions,cost_per_action_type",
        "level": "account"
    })
    rows = parse_insights_json(result)
    if not rows:
        return {}

    row = rows[0] if rows else {}
    overview = {
        "spend": safe_float(row.get("spend", 0)),
        "impressions": safe_int(row.get("impressions", 0)),
        "reach": safe_int(row.get("reach", 0)),
        "clicks": safe_int(row.get("clicks", 0)),
        "cpm": safe_float(row.get("cpm", 0)),
        "cpc": safe_float(row.get("cpc", 0)),
        "ctr": safe_float(row.get("ctr", 0)),
        "conversions": 0,
        "cost_per_conversion": 0,
    }

    # Extract leads/conversions from actions array
    actions = row.get("actions", [])
    if isinstance(actions, list):
        for action in actions:
            action_type = action.get("action_type", "")
            if action_type in ("lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped"):
                overview["conversions"] += safe_int(action.get("value", 0))

    # Extract cost per lead from cost_per_action_type
    costs = row.get("cost_per_action_type", [])
    if isinstance(costs, list):
        for cost in costs:
            action_type = cost.get("action_type", "")
            if action_type in ("lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped"):
                overview["cost_per_conversion"] = safe_float(cost.get("value", 0))
                break

    if overview["conversions"] > 0 and overview["cost_per_conversion"] == 0:
        overview["cost_per_conversion"] = overview["spend"] / overview["conversions"]

    return overview


def get_campaign_insights(account_id: str, start_date: str, end_date: str,
                          campaign_filter: Optional[List[str]] = None) -> List[dict]:
    """
    Fetch per-campaign breakdown.
    Returns list of {campaign_id, campaign_name, spend, impressions, clicks, ctr, conversions, cpa}
    """
    result = pipeboard_call("get_campaigns", {
        "account_id": account_id,
        "fields": "name,status,objective"
    })
    campaigns_raw = parse_insights_json(result)

    campaigns = []
    for c in campaigns_raw:
        cid = c.get("id", c.get("campaign_id", ""))
        name = c.get("name", "Unknown Campaign")

        # Apply campaign filter if provided
        if campaign_filter and cid not in campaign_filter and name not in campaign_filter:
            continue

        # Get insights for this campaign
        insight_result = pipeboard_call("get_insights", {
            "object_id": cid,
            "time_range": {"since": start_date, "until": end_date},
            "fields": "spend,impressions,clicks,ctr,actions,cost_per_action_type",
            "level": "campaign"
        })
        insight_rows = parse_insights_json(insight_result)
        if not insight_rows:
            continue

        row = insight_rows[0]
        spend = safe_float(row.get("spend", 0))
        if spend == 0:
            continue  # skip inactive campaigns

        conversions = extract_conversions(row)
        cpa = spend / conversions if conversions > 0 else 0

        campaigns.append({
            "campaign_id": cid,
            "campaign_name": name,
            "spend": spend,
            "impressions": safe_int(row.get("impressions", 0)),
            "clicks": safe_int(row.get("clicks", 0)),
            "ctr": safe_float(row.get("ctr", 0)),
            "conversions": conversions,
            "cpa": round(cpa, 2),
        })

    # Sort by spend descending
    campaigns.sort(key=lambda x: x["spend"], reverse=True)
    return campaigns


def get_adset_insights(account_id: str, start_date: str, end_date: str,
                       campaign_filter: Optional[List[str]] = None) -> List[dict]:
    """
    Fetch per-adset breakdown.
    Returns list of {adset_id, adset_name, campaign_name, spend, impressions, conversions, cpa}
    """
    # Get adsets - try account-level first
    result = pipeboard_call("get_adsets", {
        "account_id": account_id,
        "fields": "name,campaign_id,status"
    })
    adsets_raw = parse_insights_json(result)

    adsets = []
    for a in adsets_raw:
        adset_id = a.get("id", a.get("adset_id", ""))
        adset_name = a.get("name", "Unknown Adset")
        campaign_id = a.get("campaign_id", "")
        campaign_name = a.get("campaign", {}).get("name", "") if isinstance(a.get("campaign"), dict) else ""

        if campaign_filter and campaign_id not in campaign_filter:
            continue

        insight_result = pipeboard_call("get_insights", {
            "object_id": adset_id,
            "time_range": {"since": start_date, "until": end_date},
            "fields": "spend,impressions,clicks,actions,cost_per_action_type",
            "level": "adset"
        })
        insight_rows = parse_insights_json(insight_result)
        if not insight_rows:
            continue

        row = insight_rows[0]
        spend = safe_float(row.get("spend", 0))
        if spend == 0:
            continue

        conversions = extract_conversions(row)
        cpa = spend / conversions if conversions > 0 else 0

        adsets.append({
            "adset_id": adset_id,
            "adset_name": adset_name,
            "campaign_name": campaign_name,
            "spend": spend,
            "impressions": safe_int(row.get("impressions", 0)),
            "conversions": conversions,
            "cpa": round(cpa, 2),
        })

    adsets.sort(key=lambda x: x["spend"], reverse=True)
    return adsets


def get_top_ads(account_id: str, start_date: str, end_date: str,
                limit: int = 5, campaign_filter: Optional[List[str]] = None) -> List[dict]:
    """
    Fetch top performing ads by CTR or conversions.
    Returns top `limit` ads sorted by conversions desc, then CTR desc.
    """
    result = pipeboard_call("get_ads", {
        "account_id": account_id,
        "fields": "name,campaign_id,adset_id,status"
    })
    ads_raw = parse_insights_json(result)

    ads = []
    for ad in ads_raw:
        ad_id = ad.get("id", ad.get("ad_id", ""))
        ad_name = ad.get("name", "Unknown Ad")
        campaign_id = ad.get("campaign_id", "")

        if campaign_filter and campaign_id not in campaign_filter:
            continue

        insight_result = pipeboard_call("get_insights", {
            "object_id": ad_id,
            "time_range": {"since": start_date, "until": end_date},
            "fields": "spend,impressions,clicks,ctr,actions,cost_per_action_type",
            "level": "ad"
        })
        insight_rows = parse_insights_json(insight_result)
        if not insight_rows:
            continue

        row = insight_rows[0]
        spend = safe_float(row.get("spend", 0))
        if spend == 0:
            continue

        conversions = extract_conversions(row)
        cpa = spend / conversions if conversions > 0 else 0

        ads.append({
            "ad_id": ad_id,
            "ad_name": ad_name,
            "impressions": safe_int(row.get("impressions", 0)),
            "clicks": safe_int(row.get("clicks", 0)),
            "ctr": safe_float(row.get("ctr", 0)),
            "conversions": conversions,
            "cpa": round(cpa, 2),
        })

    # Sort: conversions desc, then CTR desc
    ads.sort(key=lambda x: (x["conversions"], x["ctr"]), reverse=True)
    return ads[:limit]


def get_previous_period(account_id: str, start_date: str, end_date: str) -> dict:
    """Fetch account overview for the previous period (same length)."""
    prev_start, prev_end = get_previous_period_range(start_date, end_date)
    return get_account_overview(account_id, prev_start, prev_end)


def fetch_all_data(account_id: str, start_date: str, end_date: str,
                   campaign_filter: Optional[List[str]] = None) -> dict:
    """
    Fetch all data needed for a complete report.
    Returns a dict with all sections.
    """
    logger.info(f"Fetching all data for {account_id} ({start_date} to {end_date})")

    overview = get_account_overview(account_id, start_date, end_date)
    campaigns = get_campaign_insights(account_id, start_date, end_date, campaign_filter)
    adsets = get_adset_insights(account_id, start_date, end_date, campaign_filter)
    top_ads = get_top_ads(account_id, start_date, end_date, 5, campaign_filter)
    previous = get_previous_period(account_id, start_date, end_date)

    prev_start, prev_end = get_previous_period_range(start_date, end_date)

    return {
        "overview": overview,
        "campaigns": campaigns,
        "adsets": adsets,
        "top_ads": top_ads,
        "previous_period": previous,
        "date_range": {"start": start_date, "end": end_date},
        "previous_date_range": {"start": prev_start, "end": prev_end},
        "fetched_at": datetime.now().isoformat(),
    }


# ─── Helpers ──────────────────────────────────────────────────────────

def safe_float(val) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return 0.0


def safe_int(val) -> int:
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return 0


def extract_conversions(row: dict) -> int:
    """Extract lead/conversion count from an insights row."""
    conversions = 0
    actions = row.get("actions", [])
    if isinstance(actions, list):
        for action in actions:
            action_type = action.get("action_type", "")
            if action_type in ("lead", "offsite_conversion.fb_pixel_lead",
                               "onsite_conversion.lead_grouped", "omni_complete_registration"):
                conversions += safe_int(action.get("value", 0))
    return conversions


# ─── CLI Test ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    account_id = sys.argv[1] if len(sys.argv) > 1 else "act_747429766205314"
    start, end = compute_date_range("last_7d")
    print(f"Fetching data for {account_id} ({start} to {end})...")

    data = fetch_all_data(account_id, start, end)
    print(json.dumps(data, indent=2, default=str))
