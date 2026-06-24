#!/usr/bin/env python3
"""
Client Report Pipeline — Main Orchestrator
Fetches Meta Ads data → Builds HTML report → Validates → Delivers to Google Drive.

Usage:
    python pipeline.py                        # Run full pipeline for all active clients
    python pipeline.py --client "Box Divvy"   # Run for specific client
    python pipeline.py --dry-run              # Dry run (no Drive upload)
    python pipeline.py --test                 # Test: save sample report + validation to /tmp
"""

import argparse
import json
import logging
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from data_fetcher import (
    account_id_label,
    compute_date_range,
    fetch_all_data,
    get_previous_period_range,
    safe_float,
    safe_int,
)
from validator import validate_report
from deliver import deliver_report_for_client

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent
CONFIG_PATH = BASE_DIR / "config.json"
TEMPLATE_PATH = BASE_DIR / "report_template.html"
DB_PATH = BASE_DIR / "state.db"


class ReportPipeline:
    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run
        self.config = self._load_config()
        self.db = sqlite3.connect(str(DB_PATH))
        self.db.row_factory = sqlite3.Row
        self.setup_db()
        self.template = self._load_template()

    def _load_config(self) -> dict:
        with open(CONFIG_PATH) as f:
            return json.load(f)

    def _load_template(self) -> str:
        with open(TEMPLATE_PATH) as f:
            return f.read()

    # ─── Database ─────────────────────────────────────────────────────

    def setup_db(self):
        cursor = self.db.cursor()
        cursor.executescript("""
            CREATE TABLE IF NOT EXISTS clients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                account_id TEXT NOT NULL,
                drive_folder TEXT,
                active INTEGER DEFAULT 1,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id INTEGER NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                html_path TEXT,
                drive_file_id TEXT,
                drive_url TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT,
                FOREIGN KEY (client_id) REFERENCES clients(id)
            );

            CREATE TABLE IF NOT EXISTS report_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                report_id INTEGER NOT NULL,
                metric_name TEXT NOT NULL,
                metric_value REAL,
                source TEXT DEFAULT 'pipeboard',
                fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (report_id) REFERENCES reports(id)
            );

            CREATE TABLE IF NOT EXISTS validation_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                report_id INTEGER NOT NULL,
                status TEXT NOT NULL,
                discrepancies TEXT,
                warnings TEXT,
                full_result TEXT,
                validated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (report_id) REFERENCES reports(id)
            );
        """)
        self.db.commit()

        # Sync clients from config
        for client in self.config.get("clients", []):
            account_label = account_id_label(client.get("account_ids") or client["account_id"])
            cursor.execute(
                "INSERT OR IGNORE INTO clients (name, account_id, drive_folder, active) VALUES (?, ?, ?, ?)",
                (client["name"], account_label, client["drive_folder"], 1 if client.get("active", True) else 0)
            )
            cursor.execute(
                "UPDATE clients SET account_id = ?, drive_folder = ?, active = ? WHERE name = ?",
                (account_label, client["drive_folder"], 1 if client.get("active", True) else 0, client["name"])
            )
        self.db.commit()

    def get_client_id(self, name: str) -> Optional[int]:
        row = self.db.execute("SELECT id FROM clients WHERE name = ?", (name,)).fetchone()
        return row["id"] if row else None

    def report_exists(self, client_id: int, start_date: str, end_date: str) -> bool:
        row = self.db.execute(
            "SELECT id FROM reports WHERE client_id = ? AND start_date = ? AND end_date = ? AND status IN ('approved', 'delivered')",
            (client_id, start_date, end_date)
        ).fetchone()
        return row is not None

    def create_report_record(self, client_id: int, start_date: str, end_date: str) -> int:
        cursor = self.db.execute(
            "INSERT INTO reports (client_id, start_date, end_date, status) VALUES (?, ?, ?, 'building')",
            (client_id, start_date, end_date)
        )
        self.db.commit()
        return cursor.lastrowid

    def update_report(self, report_id: int, **kwargs):
        sets = ", ".join(f"{k} = ?" for k in kwargs)
        vals = list(kwargs.values())
        vals.append(report_id)
        self.db.execute(f"UPDATE reports SET {sets} WHERE id = ?", vals)
        self.db.commit()

    def save_metrics(self, report_id: int, overview: dict):
        for metric, value in overview.items():
            if isinstance(value, (int, float)):
                self.db.execute(
                    "INSERT INTO report_metrics (report_id, metric_name, metric_value) VALUES (?, ?, ?)",
                    (report_id, metric, value)
                )
        self.db.commit()

    def save_validation(self, report_id: int, result):
        result_dict = result.to_dict()
        self.db.execute(
            "INSERT INTO validation_log (report_id, status, discrepancies, warnings, full_result) VALUES (?, ?, ?, ?, ?)",
            (report_id, result_dict["status"],
             json.dumps(result_dict["discrepancies"]),
             json.dumps(result_dict["warnings"]),
             json.dumps(result_dict))
        )
        self.db.commit()

    # ─── Report Building ──────────────────────────────────────────────

    def get_pending_clients(self) -> List[dict]:
        """Returns client configs that need reports this week."""
        start, end = compute_date_range("last_7d")
        pending = []
        for client in self.config.get("clients", []):
            if not client.get("active", True):
                continue
            client_id = self.get_client_id(client["name"])
            if client_id and self.report_exists(client_id, start, end):
                logger.info(f"Skipping {client['name']} — report already exists for {start} to {end}")
                continue
            pending.append(client)
        return pending

    def build_report(self, client: dict, data: dict) -> str:
        """Fill the HTML template with fetched data."""
        html = self.template
        overview = data["overview"]
        previous = data.get("previous_period", {})
        dr = data["date_range"]
        prev_dr = data.get("previous_date_range", {})

        # ─── Basic placeholders ───
        html = html.replace("{{CLIENT_NAME}}", client["name"])
        html = html.replace("{{ACCOUNT_ID}}", account_id_label(client.get("account_ids") or client["account_id"]))
        html = html.replace("{{DATE_RANGE}}", f"{dr['start']} to {dr['end']}")
        html = html.replace("{{GENERATED_DATE}}", datetime.now().strftime("%B %d, %Y at %I:%M %p"))
        html = html.replace("{{YEAR}}", str(datetime.now().year))
        html = html.replace("{{CURRENT_PERIOD}}", f"{dr['start']} to {dr['end']}")
        html = html.replace("{{PREVIOUS_PERIOD}}", f"{prev_dr.get('start', 'N/A')} to {prev_dr.get('end', 'N/A')}")

        # ─── Key Metrics ───
        html = html.replace("{{TOTAL_SPEND}}", fmt_currency(overview.get("spend", 0)))
        html = html.replace("{{TOTAL_IMPRESSIONS}}", fmt_number(overview.get("impressions", 0)))
        html = html.replace("{{TOTAL_REACH}}", fmt_number(overview.get("reach", 0)))
        html = html.replace("{{TOTAL_LEADS}}", str(overview.get("conversions", 0)))
        html = html.replace("{{CPM}}", fmt_currency(overview.get("cpm", 0)))
        html = html.replace("{{CPC}}", fmt_currency(overview.get("cpc", 0)))
        html = html.replace("{{CTR}}", f"{overview.get('ctr', 0):.2f}%")
        html = html.replace("{{COST_PER_LEAD}}", fmt_currency(overview.get("cost_per_conversion", 0)))

        # ─── Week-over-Week Changes ───
        wow_metrics = [
            ("SPEND", "spend"), ("IMPRESSIONS", "impressions"), ("REACH", "reach"),
            ("LEADS", "conversions"), ("CPM", "cpm"), ("CPC", "cpc"),
            ("CTR", "ctr"), ("CPL", "cost_per_conversion"),
        ]
        for prefix, key in wow_metrics:
            current = safe_float(overview.get(key, 0))
            prev = safe_float(previous.get(key, 0))
            change_pct, direction, arrow = compute_change(current, prev, key)
            html = html.replace(f"{{{{{prefix}_CHANGE}}}}", f"{change_pct}")
            html = html.replace(f"{{{{{prefix}_DIRECTION}}}}", direction)
            html = html.replace(f"{{{{{prefix}_ARROW}}}}", arrow)

        # ─── Campaign Rows ───
        campaign_rows = ""
        for c in data.get("campaigns", []):
            campaign_rows += f"""
            <tr>
                <td>{c['campaign_name']}</td>
                <td class="num">{fmt_currency(c['spend'])}</td>
                <td class="num">{fmt_number(c['impressions'])}</td>
                <td class="num">{fmt_number(c['clicks'])}</td>
                <td class="num">{c['ctr']:.2f}%</td>
                <td class="num">{c['conversions']}</td>
                <td class="num">{fmt_currency(c['cpa'])}</td>
            </tr>"""
        if not campaign_rows:
            campaign_rows = '<tr><td colspan="7" style="text-align:center;color:#999;">No active campaigns in this period</td></tr>'
        html = html.replace("{{CAMPAIGN_ROWS}}", campaign_rows)

        # ─── Spend Chart Bars ───
        campaigns = data.get("campaigns", [])
        max_spend = max((c["spend"] for c in campaigns), default=1)
        spend_bars = ""
        for c in campaigns[:8]:  # top 8 by spend
            pct = (c["spend"] / max_spend * 100) if max_spend > 0 else 0
            spend_bars += f"""
            <div class="bar-row">
                <div class="bar-label">{c['campaign_name'][:25]}</div>
                <div class="bar-track">
                    <div class="bar-fill" style="width: {pct:.0f}%">
                        <span class="bar-fill-value">{fmt_currency(c['spend'])}</span>
                    </div>
                </div>
            </div>"""
        html = html.replace("{{SPEND_CHART_BARS}}", spend_bars or '<p style="color:#999;">No campaign data available</p>')

        # ─── Adset Rows ───
        adset_rows = ""
        for a in data.get("adsets", []):
            adset_rows += f"""
            <tr>
                <td>{a['adset_name']}</td>
                <td>{a.get('campaign_name', 'N/A')}</td>
                <td class="num">{fmt_currency(a['spend'])}</td>
                <td class="num">{fmt_number(a['impressions'])}</td>
                <td class="num">{a['conversions']}</td>
                <td class="num">{fmt_currency(a['cpa'])}</td>
            </tr>"""
        if not adset_rows:
            adset_rows = '<tr><td colspan="6" style="text-align:center;color:#999;">No adset data available</td></tr>'
        html = html.replace("{{ADSET_ROWS}}", adset_rows)

        # ─── Top Ads Rows ───
        top_ads_rows = ""
        for i, ad in enumerate(data.get("top_ads", []), 1):
            top_ads_rows += f"""
            <tr>
                <td><span class="rank-badge">{i}</span></td>
                <td>{ad['ad_name']}</td>
                <td class="num">{fmt_number(ad['impressions'])}</td>
                <td class="num">{fmt_number(ad['clicks'])}</td>
                <td class="num">{ad['ctr']:.2f}%</td>
                <td class="num">{ad['conversions']}</td>
                <td class="num">{fmt_currency(ad['cpa'])}</td>
            </tr>"""
        if not top_ads_rows:
            top_ads_rows = '<tr><td colspan="7" style="text-align:center;color:#999;">No ad data available</td></tr>'
        html = html.replace("{{TOP_ADS_ROWS}}", top_ads_rows)

        # ─── Week-over-Week Comparison Items ───
        wow_items = ""
        wow_display = [
            ("Total Spend", "spend", True), ("Impressions", "impressions", False),
            ("Reach", "reach", False), ("Clicks", "clicks", False),
            ("CTR", "ctr", False), ("Leads", "conversions", False),
            ("CPM", "cpm", True), ("Cost per Lead", "cost_per_conversion", True),
        ]
        for label, key, is_currency in wow_display:
            current = safe_float(overview.get(key, 0))
            prev = safe_float(previous.get(key, 0))
            change_str, direction, _ = compute_change(current, prev, key)
            current_fmt = fmt_currency(current) if is_currency else (f"{current:.2f}%" if key == "ctr" else fmt_number(current))
            prev_fmt = fmt_currency(prev) if is_currency else (f"{prev:.2f}%" if key == "ctr" else fmt_number(prev))
            wow_items += f"""
            <div class="wow-item">
                <div>
                    <div class="wow-metric">{label}</div>
                    <div class="metric-change {direction}" style="margin-top:4px;">{change_str}</div>
                </div>
                <div class="wow-values">
                    <div class="wow-current">{current_fmt}</div>
                    <div class="wow-prev">prev: {prev_fmt}</div>
                </div>
            </div>"""
        html = html.replace("{{WOW_ITEMS}}", wow_items)

        # ─── Recommendations ───
        recs = generate_recommendations(overview, previous, data.get("campaigns", []))
        recs_html = ""
        for rec in recs:
            recs_html += f"""
            <div class="recommendation-item">
                <div class="rec-icon">→</div>
                <div class="rec-text">{rec}</div>
            </div>"""
        html = html.replace("{{RECOMMENDATIONS}}", recs_html or '<p style="color:#999;">No recommendations at this time.</p>')

        return html

    def run_for_client(self, client: dict, start_date: str = None, end_date: str = None) -> dict:
        """Run the full pipeline for a single client."""
        if not start_date or not end_date:
            start_date, end_date = compute_date_range("last_7d")

        client_name = client["name"]
        account_id = client.get("account_ids") or client["account_id"]
        campaign_filter = client.get("campaign_filter")

        logger.info(f"═══ Starting pipeline for {client_name} ═══")
        logger.info(f"Period: {start_date} to {end_date}")
        logger.info(f"Account: {account_id_label(account_id)}")

        # Create DB record
        client_id = self.get_client_id(client_name)
        if not client_id:
            self.db.execute(
                "INSERT INTO clients (name, account_id, drive_folder) VALUES (?, ?, ?)",
                (client_name, account_id_label(account_id), client.get("drive_folder", ""))
            )
            self.db.commit()
            client_id = self.get_client_id(client_name)

        report_id = self.create_report_record(client_id, start_date, end_date)

        result = {
            "client": client_name,
            "report_id": report_id,
            "start_date": start_date,
            "end_date": end_date,
            "status": "pending",
        }

        try:
            # ─── Step 1: Fetch Data ───
            logger.info("Step 1: Fetching data from Pipeboard...")
            data = fetch_all_data(account_id, start_date, end_date, campaign_filter)
            self.save_metrics(report_id, data["overview"])
            logger.info(f"  Spend: {data['overview'].get('spend', 0)}, "
                       f"Impressions: {data['overview'].get('impressions', 0)}, "
                       f"Leads: {data['overview'].get('conversions', 0)}")

            # ─── Step 2: Build Report ───
            logger.info("Step 2: Building HTML report...")
            html = self.build_report(client, data)
            self.update_report(report_id, status="built")

            # Save to staging
            staging_dir = os.path.expanduser(self.config.get("staging_dir", "/tmp/client-reports-staging"))
            os.makedirs(staging_dir, exist_ok=True)
            staging_path = os.path.join(staging_dir, f"{client_name.replace(' ', '_')}_{start_date}_{end_date}.html")
            with open(staging_path, "w") as f:
                f.write(html)
            self.update_report(report_id, html_path=staging_path)
            logger.info(f"  Report saved to: {staging_path}")
            result["html_path"] = staging_path

            # Copy to public directory for web access
            public_dir = "/home/mgk/code/life-os/tweet-portal/public/client-reports"
            os.makedirs(public_dir, exist_ok=True)
            public_path = os.path.join(public_dir, os.path.basename(staging_path))
            import shutil
            shutil.copy2(staging_path, public_path)
            logger.info(f"  Copied to public: {public_path}")
            result["public_url"] = f"/client-reports/{os.path.basename(staging_path)}"

            # ─── Step 3: Validate ───
            logger.info("Step 3: Validating report metrics...")
            validation = validate_report(data["overview"], account_id, start_date, end_date, campaign_filter)
            self.save_validation(report_id, validation)
            self.update_report(report_id, status=validation.status)
            result["validation"] = validation.to_dict()
            logger.info(f"  Validation: {validation.status}")

            if validation.status == "rejected":
                logger.warning(f"  ⚠️ Report REJECTED — {len(validation.discrepancies)} discrepancies")
                for d in validation.discrepancies:
                    logger.warning(f"    {d['metric']}: report={d['report_value']}, actual={d['actual_value']}, diff={d['diff_percent']:.2%}")
                result["status"] = "rejected"
                return result

            # ─── Step 4: Deliver ───
            logger.info("Step 4: Delivering report...")
            delivery = deliver_report_for_client(client, html, start_date, end_date, dry_run=self.dry_run)
            result["delivery"] = delivery

            if delivery.get("uploaded") or delivery.get("dry_run"):
                self.update_report(
                    report_id,
                    status="delivered" if not self.dry_run else "approved",
                    drive_file_id=delivery.get("file_id", ""),
                    drive_url=delivery.get("file_url", ""),
                    completed_at=datetime.now().isoformat(),
                )
                result["status"] = "delivered" if not self.dry_run else "approved"
                logger.info(f"  ✅ Report {'delivered' if not self.dry_run else 'approved (dry run)'}")
            else:
                self.update_report(report_id, status="delivery_failed")
                result["status"] = "delivery_failed"
                logger.error(f"  ❌ Delivery failed: {delivery.get('error', 'unknown')}")

        except Exception as e:
            logger.error(f"Pipeline error for {client_name}: {e}", exc_info=True)
            self.update_report(report_id, status="error")
            result["status"] = "error"
            result["error"] = str(e)

        return result

    def run(self, client_name: Optional[str] = None, start_date: str = None, end_date: str = None) -> List[dict]:
        """Run the full pipeline for pending clients (or a specific client)."""
        results = []

        if client_name:
            # Find specific client
            client = next((c for c in self.config["clients"] if c["name"] == client_name), None)
            if not client:
                logger.error(f"Client not found: {client_name}")
                return [{"error": f"Client not found: {client_name}"}]
            results.append(self.run_for_client(client, start_date=start_date, end_date=end_date))
        else:
            pending = self.get_pending_clients()
            if not pending:
                logger.info("No pending clients this week.")
                return []
            for client in pending:
                results.append(self.run_for_client(client, start_date=start_date, end_date=end_date))

        return results


# ─── Formatting Helpers ───────────────────────────────────────────────

def fmt_currency(val) -> str:
    val = safe_float(val)
    if val >= 1000:
        return f"${val:,.0f}"
    return f"${val:,.2f}"


def fmt_number(val) -> str:
    val = safe_int(val)
    if val >= 1_000_000:
        return f"{val / 1_000_000:.1f}M"
    if val >= 1_000:
        return f"{val:,}"
    return str(val)


def compute_change(current: float, previous: float, metric_key: str = "") -> tuple:
    """
    Compute percentage change. Returns (change_str, direction_class, arrow).
    For cost metrics (cpm, cpc, cost_per_conversion), lower is better.
    """
    if previous == 0:
        if current == 0:
            return "0%", "neutral", "—"
        return "New", "up", "↑"

    pct = ((current - previous) / abs(previous)) * 100

    # For cost metrics, lower is better (so decrease = green)
    cost_metrics = {"cpm", "cpc", "cost_per_conversion", "spend"}
    if metric_key in cost_metrics:
        if pct > 0:
            direction = "down"  # cost went up = bad
            arrow = "↑"
        elif pct < 0:
            direction = "up"  # cost went down = good
            arrow = "↓"
        else:
            direction = "neutral"
            arrow = "—"
    else:
        if pct > 0:
            direction = "up"
            arrow = "↑"
        elif pct < 0:
            direction = "down"
            arrow = "↓"
        else:
            direction = "neutral"
            arrow = "—"

    return f"{abs(pct):.1f}%", direction, arrow


def generate_recommendations(overview: dict, previous: dict, campaigns: List[dict]) -> List[str]:
    """Generate data-driven recommendations based on performance."""
    recs = []
    spend = safe_float(overview.get("spend", 0))
    conversions = safe_int(overview.get("conversions", 0))
    cpl = safe_float(overview.get("cost_per_conversion", 0))
    ctr = safe_float(overview.get("ctr", 0))
    prev_spend = safe_float(previous.get("spend", 0))
    prev_conversions = safe_int(previous.get("conversions", 0))
    prev_cpl = safe_float(previous.get("cost_per_conversion", 0))
    prev_ctr = safe_float(previous.get("ctr", 0))

    # CTR analysis
    if ctr < 1.0:
        recs.append(
            f"<strong>Low CTR ({ctr:.2f}%):</strong> Consider refreshing ad creatives. "
            f"Test new headlines and imagery to improve click-through rates. Industry benchmark is typically 1-2%."
        )
    elif prev_ctr > 0 and ctr < prev_ctr * 0.8:
        recs.append(
            f"<strong>CTR declined {((prev_ctr - ctr) / prev_ctr * 100):.0f}%:</strong> "
            f"Ad fatigue may be setting in. Consider rotating creatives or expanding audiences."
        )

    # Cost per lead analysis
    if cpl > 0 and prev_cpl > 0:
        if cpl > prev_cpl * 1.2:
            recs.append(
                f"<strong>Cost per lead increased by {((cpl - prev_cpl) / prev_cpl * 100):.0f}%:</strong> "
                f"Review audience targeting and landing page performance. Consider tightening audience segments."
            )
        elif cpl < prev_cpl * 0.8:
            recs.append(
                f"<strong>Cost per lead improved by {((prev_cpl - cpl) / prev_cpl * 100):.0f}%:</strong> "
                f"Great progress! Consider scaling spend on top-performing ad sets to capitalize on this efficiency."
            )

    # Conversion volume
    if conversions == 0 and spend > 50:
        recs.append(
            f"<strong>No conversions recorded:</strong> Verify pixel/conversion tracking is properly configured. "
            f"${spend:.0f} spent with zero recorded conversions suggests a tracking issue."
        )
    elif prev_conversions > 0 and conversions > prev_conversions * 1.5:
        recs.append(
            f"<strong>Conversion volume up {((conversions - prev_conversions) / prev_conversions * 100):.0f}%:</strong> "
            f"Excellent growth. Monitor lead quality to ensure volume increase maintains conversion rates downstream."
        )

    # Campaign concentration
    if len(campaigns) > 1:
        top_camp = campaigns[0]
        top_pct = (top_camp["spend"] / spend * 100) if spend > 0 else 0
        if top_pct > 80:
            recs.append(
                f"<strong>Budget concentration:</strong> {top_pct:.0f}% of spend is in '{top_camp['campaign_name']}'. "
                f"Consider diversifying budget across campaigns to reduce risk and find new opportunities."
            )

    # Spend trend
    if prev_spend > 0 and spend > prev_spend * 1.3:
        recs.append(
            f"<strong>Spend increased {((spend - prev_spend) / prev_spend * 100):.0f}% WoW:</strong> "
            f"Monitor efficiency metrics closely. Rapid spend increases can temporarily inflate CPMs."
        )

    # If nothing flagged, add a generic positive note
    if not recs:
        recs.append(
            "<strong>Steady performance:</strong> Metrics are stable week-over-week. "
            "Consider A/B testing new creative variations to find incremental improvements."
        )

    return recs


# ─── CLI Entry Point ──────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Weekly Client Report Pipeline")
    parser.add_argument("--client", type=str, help="Run for specific client name")
    parser.add_argument("--start", type=str, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end", type=str, help="End date (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true", help="Skip Google Drive upload")
    parser.add_argument("--test", action="store_true", help="Test mode: save sample to /tmp")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    pipeline = ReportPipeline(dry_run=args.dry_run or args.test)

    if args.test:
        # Test mode: run for first client, save outputs to /tmp
        client = pipeline.config["clients"][0]
        logger.info(f"TEST MODE: Running for {client['name']}")
        result = pipeline.run_for_client(client)

        # Copy report to /tmp/sample_report.html
        if result.get("html_path"):
            import shutil
            shutil.copy2(result["html_path"], "/tmp/sample_report.html")
            logger.info("Sample report saved to /tmp/sample_report.html")

        # Save validation to /tmp
        if result.get("validation"):
            with open("/tmp/validation_output.json", "w") as f:
                json.dump(result["validation"], f, indent=2)
            logger.info("Validation output saved to /tmp/validation_output.json")

        # Save full result
        with open("/tmp/pipeline_result.json", "w") as f:
            json.dump(result, f, indent=2, default=str)
        logger.info("Full pipeline result saved to /tmp/pipeline_result.json")

        print(f"\n{'═' * 60}")
        print(f"Pipeline Result: {result['status']}")
        print(f"{'═' * 60}")
        print(json.dumps(result, indent=2, default=str))

    else:
        results = pipeline.run(client_name=args.client, start_date=args.start, end_date=args.end)
        for r in results:
            print(f"\n{r['client']}: {r['status']}")
            if r.get("error"):
                print(f"  Error: {r['error']}")
            if r.get("delivery"):
                print(f"  Delivery: {r['delivery'].get('status', 'N/A')}")
            if r.get("report_id"):
                print(f"  Report ID: {r['report_id']}")


if __name__ == "__main__":
    main()
