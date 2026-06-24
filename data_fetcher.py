"""
Pipeboard Meta Ads MCP Data Fetcher
Fetches campaign/adset/ad insights via Pipeboard's JSON-RPC 2.0 API.
"""

import json
import os
import subprocess
import time
import logging
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple, Union
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


def get_meta_token() -> str:
    """Load a Meta Graph API token without hardcoding secrets."""
    for env_name in ("FACEBOOK_ACCESS_TOKEN", "META_ACCESS_TOKEN", "META_ADS_TOKEN"):
        token = os.environ.get(env_name)
        if token:
            return token.strip()

    config = load_config()
    token_file = config.get("meta_token_file", "~/.secrets/meta-ads-token.txt")
    token_path = os.path.expanduser(token_file)
    if os.path.exists(token_path):
        with open(token_path) as f:
            return f.read().strip()

    secret_name = config.get("meta_token_secret", "meta-ads-token")
    result = subprocess.run(
        [os.path.expanduser("~/clawd/scripts/secrets.sh"), "get", secret_name],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    raise RuntimeError("Meta Graph API token not found in env, token file, or secrets.sh")


def pipeboard_unavailable(exc: Exception) -> bool:
    message = str(exc).lower()
    markers = (
        "pipeboard limit exceeded",
        "weekly limit",
        "limit_exceeded",
        "rate limit",
        "too many requests",
        "timeout",
        "timed out",
        "502",
        "503",
        "504",
        "overloaded",
    )
    return any(marker in message for marker in markers)


def graph_api_get(path: str, params: dict) -> dict:
    """Call Meta Graph API. Never include the token in logs/errors."""
    token = get_meta_token()
    api_version = load_config().get("meta_api_version", "v22.0")
    params = dict(params)
    params["access_token"] = token
    url = f"https://graph.facebook.com/{api_version}/{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        try:
            payload = json.loads(body)
            message = payload.get("error", {}).get("message", body[:300])
        except json.JSONDecodeError:
            message = body[:300]
        raise RuntimeError(f"Meta Graph API error {e.code}: {message}") from e


def graph_insights(account_or_object_id: str, start_date: str, end_date: str, fields: str,
                   level: str, limit: int = 500) -> List[dict]:
    rows: List[dict] = []
    payload = graph_api_get(f"{account_or_object_id}/insights", {
        "fields": fields,
        "time_range": json.dumps({"since": start_date, "until": end_date}),
        "level": level,
        "limit": str(limit),
    })
    while True:
        rows.extend(payload.get("data", []))
        next_url = payload.get("paging", {}).get("next")
        if not next_url:
            break
        req = urllib.request.Request(next_url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Meta Graph API paging error {e.code}") from e
    return rows


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
        limit_markers = (
            "weekly limit for AI tool executions",
            "limit_exceeded",
            "Please upgrade to Pro",
        )
        if any(marker in text for marker in limit_markers):
            raise RuntimeError(f"Pipeboard limit exceeded: {text[:300]}")
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

AccountIds = Union[str, List[str], Tuple[str, ...]]


def coerce_account_ids(account_id: AccountIds) -> List[str]:
    """Normalize a client account config into one or more Meta ad account IDs."""
    if isinstance(account_id, (list, tuple)):
        return [str(a).strip() for a in account_id if str(a).strip()]
    if isinstance(account_id, str) and "," in account_id:
        return [a.strip() for a in account_id.split(",") if a.strip()]
    return [str(account_id).strip()] if str(account_id).strip() else []


def account_id_label(account_id: AccountIds) -> str:
    return ", ".join(coerce_account_ids(account_id))


def _sum_overviews(overviews: List[dict]) -> dict:
    """Merge account-level rows and recalculate derived ratios from totals."""
    merged = {
        "spend": round(sum(safe_float(o.get("spend", 0)) for o in overviews), 2),
        "impressions": sum(safe_int(o.get("impressions", 0)) for o in overviews),
        "reach": sum(safe_int(o.get("reach", 0)) for o in overviews),
        "clicks": sum(safe_int(o.get("clicks", 0)) for o in overviews),
        "conversions": sum(safe_int(o.get("conversions", 0)) for o in overviews),
        "account_ids": [a for o in overviews for a in coerce_account_ids(o.get("account_id", ""))],
    }
    spend = safe_float(merged["spend"])
    impressions = safe_int(merged["impressions"])
    clicks = safe_int(merged["clicks"])
    conversions = safe_int(merged["conversions"])
    merged["cpm"] = round((spend / impressions * 1000), 4) if impressions else 0
    merged["cpc"] = round((spend / clicks), 4) if clicks else 0
    merged["ctr"] = round((clicks / impressions * 100), 4) if impressions else 0
    merged["cost_per_conversion"] = round((spend / conversions), 4) if conversions else 0
    return merged


def _merge_entity_rows(rows: List[dict], id_key: str, name_key: str, sort_key: str = "spend") -> List[dict]:
    """Merge rows from multiple ad accounts without double-counting the same entity ID."""
    merged: Dict[str, dict] = {}
    for row in rows:
        entity_id = str(row.get(id_key) or "").strip()
        account = str(row.get("account_id") or "").strip()
        key = entity_id or f"{account}:{row.get(name_key, '')}"
        if not key:
            continue
        if key not in merged:
            merged[key] = dict(row)
            continue

        current = merged[key]
        for metric in ("spend", "impressions", "reach", "clicks", "conversions"):
            if metric in row or metric in current:
                if metric == "spend":
                    current[metric] = round(safe_float(current.get(metric, 0)) + safe_float(row.get(metric, 0)), 2)
                else:
                    current[metric] = safe_int(current.get(metric, 0)) + safe_int(row.get(metric, 0))

        spend = safe_float(current.get("spend", 0))
        impressions = safe_int(current.get("impressions", 0))
        clicks = safe_int(current.get("clicks", 0))
        conversions = safe_int(current.get("conversions", 0))
        if "ctr" in current:
            current["ctr"] = round((clicks / impressions * 100), 4) if impressions else 0
        if "cpa" in current:
            current["cpa"] = round((spend / conversions), 2) if conversions else 0

    result = list(merged.values())
    result.sort(key=lambda x: safe_float(x.get(sort_key, 0)), reverse=True)
    return result


def _overview_from_row(row: dict, account_id: str) -> dict:
    overview = {
        "account_id": account_id,
        "spend": safe_float(row.get("spend", 0)),
        "impressions": safe_int(row.get("impressions", 0)),
        "reach": safe_int(row.get("reach", 0)),
        "clicks": safe_int(row.get("clicks", 0)),
        "cpm": safe_float(row.get("cpm", 0)),
        "cpc": safe_float(row.get("cpc", 0)),
        "ctr": safe_float(row.get("ctr", 0)),
        "conversions": extract_conversions(row),
        "cost_per_conversion": 0,
    }
    costs = row.get("cost_per_action_type", [])
    if isinstance(costs, list):
        for cost in costs:
            action_type = cost.get("action_type", "")
            if action_type in ("lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped", "omni_complete_registration"):
                overview["cost_per_conversion"] = safe_float(cost.get("value", 0))
                break
    if overview["conversions"] > 0 and overview["cost_per_conversion"] == 0:
        overview["cost_per_conversion"] = overview["spend"] / overview["conversions"]
    return overview


def get_account_overview(account_id: AccountIds, start_date: str, end_date: str) -> dict:
    """
    Fetch account-level aggregate metrics for the given date range.
    Returns: {spend, impressions, reach, clicks, cpm, cpc, ctr, conversions, cost_per_conversion, ...}
    """
    account_ids = coerce_account_ids(account_id)
    if len(account_ids) > 1:
        overviews = [get_account_overview(a, start_date, end_date) for a in account_ids]
        return _sum_overviews(overviews)

    single_account_id = account_ids[0]
    try:
        result = pipeboard_call("get_insights", {
            "object_id": single_account_id,
            "time_range": {"since": start_date, "until": end_date},
            "fields": "spend,impressions,reach,clicks,cpm,cpc,ctr,actions,cost_per_action_type",
            "level": "account"
        })
        rows = parse_insights_json(result)
    except Exception as e:
        if not pipeboard_unavailable(e):
            raise
        logger.warning(f"Pipeboard unavailable for account overview; falling back to Meta Graph API for {single_account_id}: {e}")
        rows = graph_insights(
            single_account_id,
            start_date,
            end_date,
            "spend,impressions,reach,clicks,cpm,cpc,ctr,actions,cost_per_action_type",
            "account",
            limit=50,
        )
    if not rows:
        return {}

    return _overview_from_row(rows[0], single_account_id)


def get_campaign_insights(account_id: AccountIds, start_date: str, end_date: str,
                          campaign_filter: Optional[List[str]] = None) -> List[dict]:
    """
    Fetch per-campaign breakdown.
    Returns list of {campaign_id, campaign_name, spend, impressions, clicks, ctr, conversions, cpa}
    """
    account_ids = coerce_account_ids(account_id)
    if len(account_ids) > 1:
        rows = []
        for single_account_id in account_ids:
            rows.extend(get_campaign_insights(single_account_id, start_date, end_date, campaign_filter))
        return _merge_entity_rows(rows, "campaign_id", "campaign_name")

    single_account_id = account_ids[0]
    campaigns = []

    try:
        result = pipeboard_call("get_campaigns", {
            "account_id": single_account_id,
            "fields": "name,status,objective"
        })
        campaigns_raw = parse_insights_json(result)

        for c in campaigns_raw:
            cid = c.get("id", c.get("campaign_id", ""))
            name = c.get("name", "Unknown Campaign")

            if campaign_filter and cid not in campaign_filter and name not in campaign_filter:
                continue

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
                continue

            conversions = extract_conversions(row)
            cpa = spend / conversions if conversions > 0 else 0

            campaigns.append({
                "account_id": single_account_id,
                "campaign_id": cid,
                "campaign_name": name,
                "spend": spend,
                "impressions": safe_int(row.get("impressions", 0)),
                "clicks": safe_int(row.get("clicks", 0)),
                "ctr": safe_float(row.get("ctr", 0)),
                "conversions": conversions,
                "cpa": round(cpa, 2),
            })
    except Exception as e:
        if not pipeboard_unavailable(e):
            raise
        logger.warning(f"Pipeboard unavailable for campaign insights; falling back to Meta Graph API for {single_account_id}: {e}")
        rows = graph_insights(
            single_account_id,
            start_date,
            end_date,
            "campaign_id,campaign_name,spend,impressions,clicks,ctr,actions,cost_per_action_type",
            "campaign",
        )
        for row in rows:
            cid = row.get("campaign_id", "")
            name = row.get("campaign_name", "Unknown Campaign")
            if campaign_filter and cid not in campaign_filter and name not in campaign_filter:
                continue
            spend = safe_float(row.get("spend", 0))
            if spend == 0:
                continue
            conversions = extract_conversions(row)
            campaigns.append({
                "account_id": single_account_id,
                "campaign_id": cid,
                "campaign_name": name,
                "spend": spend,
                "impressions": safe_int(row.get("impressions", 0)),
                "clicks": safe_int(row.get("clicks", 0)),
                "ctr": safe_float(row.get("ctr", 0)),
                "conversions": conversions,
                "cpa": round(spend / conversions, 2) if conversions else 0,
            })

    campaigns.sort(key=lambda x: x["spend"], reverse=True)
    return campaigns


def get_adset_insights(account_id: AccountIds, start_date: str, end_date: str,
                       campaign_filter: Optional[List[str]] = None) -> List[dict]:
    """
    Fetch per-adset breakdown.
    Returns list of {adset_id, adset_name, campaign_name, spend, impressions, conversions, cpa}
    """
    account_ids = coerce_account_ids(account_id)
    if len(account_ids) > 1:
        rows = []
        for single_account_id in account_ids:
            rows.extend(get_adset_insights(single_account_id, start_date, end_date, campaign_filter))
        return _merge_entity_rows(rows, "adset_id", "adset_name")

    single_account_id = account_ids[0]
    adsets = []

    try:
        result = pipeboard_call("get_adsets", {
            "account_id": single_account_id,
            "fields": "name,campaign_id,status"
        })
        adsets_raw = parse_insights_json(result)

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
            adsets.append({
                "account_id": single_account_id,
                "adset_id": adset_id,
                "adset_name": adset_name,
                "campaign_name": campaign_name,
                "spend": spend,
                "impressions": safe_int(row.get("impressions", 0)),
                "conversions": conversions,
                "cpa": round(spend / conversions, 2) if conversions else 0,
            })
    except Exception as e:
        if not pipeboard_unavailable(e):
            raise
        logger.warning(f"Pipeboard unavailable for adset insights; falling back to Meta Graph API for {single_account_id}: {e}")
        rows = graph_insights(
            single_account_id,
            start_date,
            end_date,
            "adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,actions,cost_per_action_type",
            "adset",
        )
        for row in rows:
            campaign_id = row.get("campaign_id", "")
            if campaign_filter and campaign_id not in campaign_filter and row.get("campaign_name") not in campaign_filter:
                continue
            spend = safe_float(row.get("spend", 0))
            if spend == 0:
                continue
            conversions = extract_conversions(row)
            adsets.append({
                "account_id": single_account_id,
                "adset_id": row.get("adset_id", ""),
                "adset_name": row.get("adset_name", "Unknown Adset"),
                "campaign_name": row.get("campaign_name", ""),
                "spend": spend,
                "impressions": safe_int(row.get("impressions", 0)),
                "conversions": conversions,
                "cpa": round(spend / conversions, 2) if conversions else 0,
            })

    adsets.sort(key=lambda x: x["spend"], reverse=True)
    return adsets


def get_top_ads(account_id: AccountIds, start_date: str, end_date: str,
                limit: int = 5, campaign_filter: Optional[List[str]] = None) -> List[dict]:
    """
    Fetch top performing ads by CTR or conversions.
    Returns top `limit` ads sorted by conversions desc, then CTR desc.
    """
    account_ids = coerce_account_ids(account_id)
    if len(account_ids) > 1:
        rows = []
        for single_account_id in account_ids:
            rows.extend(get_top_ads(single_account_id, start_date, end_date, limit, campaign_filter))
        return _merge_entity_rows(rows, "ad_id", "ad_name", sort_key="conversions")[:limit]

    single_account_id = account_ids[0]
    ads = []

    try:
        result = pipeboard_call("get_ads", {
            "account_id": single_account_id,
            "fields": "name,campaign_id,adset_id,status"
        })
        ads_raw = parse_insights_json(result)

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
            ads.append({
                "account_id": single_account_id,
                "ad_id": ad_id,
                "ad_name": ad_name,
                "spend": spend,
                "impressions": safe_int(row.get("impressions", 0)),
                "clicks": safe_int(row.get("clicks", 0)),
                "ctr": safe_float(row.get("ctr", 0)),
                "conversions": conversions,
                "cpa": round(spend / conversions, 2) if conversions else 0,
            })
    except Exception as e:
        if not pipeboard_unavailable(e):
            raise
        logger.warning(f"Pipeboard unavailable for ad insights; falling back to Meta Graph API for {single_account_id}: {e}")
        rows = graph_insights(
            single_account_id,
            start_date,
            end_date,
            "ad_id,ad_name,campaign_id,campaign_name,spend,impressions,clicks,ctr,actions,cost_per_action_type",
            "ad",
        )
        for row in rows:
            campaign_id = row.get("campaign_id", "")
            if campaign_filter and campaign_id not in campaign_filter and row.get("campaign_name") not in campaign_filter:
                continue
            spend = safe_float(row.get("spend", 0))
            if spend == 0:
                continue
            conversions = extract_conversions(row)
            ads.append({
                "account_id": single_account_id,
                "ad_id": row.get("ad_id", ""),
                "ad_name": row.get("ad_name", "Unknown Ad"),
                "spend": spend,
                "impressions": safe_int(row.get("impressions", 0)),
                "clicks": safe_int(row.get("clicks", 0)),
                "ctr": safe_float(row.get("ctr", 0)),
                "conversions": conversions,
                "cpa": round(spend / conversions, 2) if conversions else 0,
            })

    ads.sort(key=lambda x: (x["conversions"], x["ctr"]), reverse=True)
    return ads[:limit]


def get_previous_period(account_id: AccountIds, start_date: str, end_date: str) -> dict:
    """Fetch account overview for the previous period (same length)."""
    prev_start, prev_end = get_previous_period_range(start_date, end_date)
    return get_account_overview(account_id, prev_start, prev_end)


def fetch_all_data(account_id: AccountIds, start_date: str, end_date: str,
                   campaign_filter: Optional[List[str]] = None) -> dict:
    """
    Fetch all data needed for a complete report.
    Returns a dict with all sections.
    """
    logger.info(f"Fetching all data for {account_id_label(account_id)} ({start_date} to {end_date})")

    overview = get_account_overview(account_id, start_date, end_date)
    campaigns = get_campaign_insights(account_id, start_date, end_date, campaign_filter)
    adsets = get_adset_insights(account_id, start_date, end_date, campaign_filter)
    top_ads = get_top_ads(account_id, start_date, end_date, 5, campaign_filter)
    previous = get_previous_period(account_id, start_date, end_date)

    prev_start, prev_end = get_previous_period_range(start_date, end_date)

    return {
        "account_ids": coerce_account_ids(account_id),
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
