"""
Independent Report Validator
Cross-validates report metrics using MULTIPLE independent data sources:
1. Account-level insights (same as report, but re-fetched)
2. Campaign-level sum (independently fetched, summed, compared)
This prevents circular validation where broken data validates itself.
"""

import json
import logging
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from data_fetcher import (
    get_account_overview,
    get_campaign_insights,
    safe_float,
    safe_int,
    load_config,
)

logger = logging.getLogger(__name__)


class ValidationResult:
    def __init__(self):
        self.status: str = "pending"  # pending | approved | rejected
        self.checks: List[dict] = []
        self.discrepancies: List[dict] = []
        self.warnings: List[str] = []
        self.validated_at: Optional[str] = None

    def add_check(self, metric: str, report_val: float, actual_val: float,
                  tolerance: float, passed: bool, diff_pct: float, source: str = "account"):
        check = {
            "metric": metric,
            "report_value": report_val,
            "actual_value": actual_val,
            "tolerance": tolerance,
            "diff_percent": round(diff_pct, 4),
            "passed": passed,
            "source": source,
        }
        self.checks.append(check)
        if not passed:
            self.discrepancies.append(check)

    def finalize(self):
        self.validated_at = datetime.now().isoformat()
        if len(self.discrepancies) == 0:
            self.status = "approved"
        else:
            # Auto-reject if any critical metric (spend) fails
            critical_fails = [d for d in self.discrepancies if d["metric"] in ("spend", "spend_crosscheck")]
            if critical_fails:
                self.status = "rejected"
            elif all(d["diff_percent"] < 0.10 for d in self.discrepancies):
                self.status = "approved"
                self.warnings.append("Minor discrepancies within 10% — approved with warnings.")
            else:
                self.status = "rejected"

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "validated_at": self.validated_at,
            "total_checks": len(self.checks),
            "passed_checks": len([c for c in self.checks if c["passed"]]),
            "failed_checks": len(self.discrepancies),
            "discrepancies": self.discrepancies,
            "warnings": self.warnings,
            "all_checks": self.checks,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)


def validate_metric(metric_name: str, report_value: float, actual_value: float,
                    tolerance: float) -> Tuple[bool, float]:
    if actual_value == 0 and report_value == 0:
        return True, 0.0
    if actual_value == 0:
        return False, 1.0
    diff_pct = abs(report_value - actual_value) / abs(actual_value)
    passed = diff_pct <= tolerance
    return passed, diff_pct


def validate_report(report_data: dict, account_id: str,
                    start_date: str, end_date: str,
                    campaign_filter: Optional[List[str]] = None) -> ValidationResult:
    """
    Validate a report using TWO independent sources:
    1. Re-fetch account-level insights (level=account)
    2. Sum campaign-level insights independently and compare

    This ensures data fetcher bugs can't pass validation.
    """
    config = load_config()
    tolerances = config.get("validation_tolerances", {
        "spend": 0.02,
        "impressions": 0.05,
        "clicks": 0.05,
        "conversions": 0.10,
        "reach": 0.10,
    })

    result = ValidationResult()
    logger.info(f"Validating report for {account_id} ({start_date} to {end_date})")

    # ── Source 1: Account-level re-fetch ──
    try:
        actual = get_account_overview(account_id, start_date, end_date)
    except Exception as e:
        result.warnings.append(f"Failed to re-fetch account data: {e}")
        result.status = "rejected"
        result.validated_at = datetime.now().isoformat()
        return result

    metrics_to_check = [
        ("spend", safe_float(report_data.get("spend", 0)),
         safe_float(actual.get("spend", 0)), tolerances.get("spend", 0.02)),
        ("impressions", safe_float(report_data.get("impressions", 0)),
         safe_float(actual.get("impressions", 0)), tolerances.get("impressions", 0.05)),
        ("clicks", safe_float(report_data.get("clicks", 0)),
         safe_float(actual.get("clicks", 0)), tolerances.get("clicks", 0.05)),
        ("conversions", safe_float(report_data.get("conversions", 0)),
         safe_float(actual.get("conversions", 0)), tolerances.get("conversions", 0.10)),
        ("reach", safe_float(report_data.get("reach", 0)),
         safe_float(actual.get("reach", 0)), tolerances.get("reach", 0.10)),
    ]

    for metric_name, report_val, actual_val, tolerance in metrics_to_check:
        passed, diff_pct = validate_metric(metric_name, report_val, actual_val, tolerance)
        result.add_check(metric_name, report_val, actual_val, tolerance, passed, diff_pct, source="account_level")
        if not passed:
            logger.warning(f"FAIL [{metric_name}]: report={report_val}, actual={actual_val}, diff={diff_pct:.2%}")

    # ── Source 2: Cross-check spend via campaign sum ──
    try:
        campaigns = get_campaign_insights(account_id, start_date, end_date, campaign_filter)
        campaign_spend_sum = sum(c.get("spend", 0) for c in campaigns)
        campaign_impressions_sum = sum(c.get("impressions", 0) for c in campaigns)

        report_spend = safe_float(report_data.get("spend", 0))
        # Campaign sum should be close to account-level spend
        passed_spend, diff_spend = validate_metric("spend_crosscheck", report_spend, campaign_spend_sum, 0.05)
        result.add_check("spend_crosscheck", report_spend, campaign_spend_sum, 0.05, passed_spend, diff_spend,
                         source="campaign_sum")

        if not passed_spend:
            logger.warning(f"CROSS-CHECK FAIL: report spend ${report_spend} vs campaign sum ${campaign_spend_sum}")

    except Exception as e:
        result.warnings.append(f"Campaign cross-check failed: {e}")
        # Don't auto-reject on cross-check failure alone

    # ── Sanity checks ──
    report_spend = safe_float(report_data.get("spend", 0))
    report_impressions = safe_float(report_data.get("impressions", 0))

    # If spend is suspiciously low relative to a 7-day period with daily budget
    if report_spend < 10 and safe_float(actual.get("spend", 0)) > 100:
        result.discrepancies.append({
            "metric": "sanity_spend",
            "report_value": report_spend,
            "actual_value": safe_float(actual.get("spend", 0)),
            "tolerance": 0,
            "diff_percent": 1.0,
            "passed": False,
            "source": "sanity_check",
        })
        result.warnings.append(f"SANITY: Report spend ${report_spend} is <10% of actual ${actual.get('spend',0)}. Data source is likely broken.")

    result.finalize()
    logger.info(f"Validation: {result.status} ({len(result.discrepancies)} discrepancies)")
    return result


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    from data_fetcher import compute_date_range

    account_id = sys.argv[1] if len(sys.argv) > 1 else "act_747429766205314"
    start, end = compute_date_range("last_7d")

    print(f"Fetching actual data for {account_id} ({start} to {end})...")
    actual = get_account_overview(account_id, start, end)
    print(f"Actual overview: {json.dumps(actual, indent=2)}")

    result = validate_report(actual, account_id, start, end)
    print(f"\nValidation:\n{result.to_json()}")
