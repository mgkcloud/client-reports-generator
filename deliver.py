"""
Google Drive Report Delivery
Uploads approved HTML reports to client folders on Google Drive.
Uses service account with domain-wide delegation.
"""

import json
import logging
import os
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).parent / "config.json"


def load_config() -> dict:
    with open(CONFIG_PATH) as f:
        return json.load(f)


def get_drive_service():
    """Build Google Drive API service with domain delegation."""
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError:
        raise ImportError(
            "google-auth and google-api-python-client required. "
            "Install: pip install google-auth google-api-python-client"
        )

    config = load_config()
    creds_file = os.path.expanduser(config["google_creds"])
    subject = config["google_subject"]

    creds = service_account.Credentials.from_service_account_file(
        creds_file,
        scopes=["https://www.googleapis.com/auth/drive"]
    ).with_subject(subject)

    return build("drive", "v3", credentials=creds)


def find_or_create_reports_folder(service, parent_folder_id: str) -> str:
    """
    Find or create a 'Reports' subfolder inside the given parent folder.
    Returns the folder ID.
    """
    # Search for existing Reports folder
    query = (
        f"'{parent_folder_id}' in parents and "
        f"name = 'Reports' and "
        f"mimeType = 'application/vnd.google-apps.folder' and "
        f"trashed = false"
    )
    results = service.files().list(
        q=query,
        fields="files(id, name)",
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()

    files = results.get("files", [])
    if files:
        logger.info(f"Found existing Reports folder: {files[0]['id']}")
        return files[0]["id"]

    # Create Reports folder
    folder_metadata = {
        "name": "Reports",
        "mimeType": "application/vnd.google-apps.folder",
        "parents": [parent_folder_id],
    }
    folder = service.files().create(
        body=folder_metadata,
        fields="id",
        supportsAllDrives=True,
    ).execute()

    folder_id = folder["id"]
    logger.info(f"Created Reports folder: {folder_id}")
    return folder_id


def generate_report_filename(client_name: str, start_date: str, end_date: str) -> str:
    """Generate a filename like '2026-W06_Weekly_Report.html'."""
    from datetime import datetime as dt
    start = dt.strptime(start_date, "%Y-%m-%d")
    year, week, _ = start.isocalendar()
    return f"{year}-W{week:02d}_Weekly_Report.html"


def upload_report(
    client_name: str,
    drive_folder_id: str,
    report_html: str,
    start_date: str,
    end_date: str,
    dry_run: bool = False,
) -> dict:
    """
    Upload an HTML report to the client's Google Drive folder.

    Args:
        client_name: Client display name
        drive_folder_id: Google Drive parent folder ID
        report_html: The HTML content to upload
        start_date: Report period start date
        end_date: Report period end date
        dry_run: If True, skip actual upload

    Returns:
        dict with upload status and file info
    """
    filename = generate_report_filename(client_name, start_date, end_date)

    result = {
        "client": client_name,
        "filename": filename,
        "folder_id": drive_folder_id,
        "uploaded": False,
        "file_id": None,
        "file_url": None,
        "dry_run": dry_run,
        "timestamp": datetime.now().isoformat(),
    }

    if dry_run:
        logger.info(f"DRY RUN: Would upload '{filename}' to folder {drive_folder_id}")
        result["status"] = "dry_run"
        return result

    try:
        from googleapiclient.http import MediaInMemoryUpload

        service = get_drive_service()

        # Find or create Reports subfolder
        reports_folder_id = find_or_create_reports_folder(service, drive_folder_id)

        # Check if file already exists (avoid duplicates)
        query = (
            f"'{reports_folder_id}' in parents and "
            f"name = '{filename}' and "
            f"trashed = false"
        )
        existing = service.files().list(
            q=query,
            fields="files(id, name)",
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()

        existing_files = existing.get("files", [])

        media = MediaInMemoryUpload(
            report_html.encode("utf-8"),
            mimetype="text/html",
            resumable=True,
        )

        if existing_files:
            # Update existing file
            file_id = existing_files[0]["id"]
            updated = service.files().update(
                fileId=file_id,
                media_body=media,
                supportsAllDrives=True,
            ).execute()
            result["file_id"] = file_id
            result["uploaded"] = True
            result["status"] = "updated"
            logger.info(f"Updated existing report: {filename} (ID: {file_id})")
        else:
            # Create new file
            file_metadata = {
                "name": filename,
                "parents": [reports_folder_id],
            }
            uploaded_file = service.files().create(
                body=file_metadata,
                media_body=media,
                fields="id, webViewLink",
                supportsAllDrives=True,
            ).execute()
            result["file_id"] = uploaded_file["id"]
            result["file_url"] = uploaded_file.get("webViewLink", "")
            result["uploaded"] = True
            result["status"] = "created"
            logger.info(f"Uploaded new report: {filename} (ID: {uploaded_file['id']})")

        result["reports_folder_id"] = reports_folder_id

    except Exception as e:
        logger.error(f"Failed to upload report: {e}")
        result["status"] = "error"
        result["error"] = str(e)

    return result


def deliver_report_for_client(client_config: dict, report_html: str,
                              start_date: str, end_date: str,
                              dry_run: bool = False) -> dict:
    """
    Convenience function to deliver a report using client config.
    """
    return upload_report(
        client_name=client_config["name"],
        drive_folder_id=client_config["drive_folder"],
        report_html=report_html,
        start_date=start_date,
        end_date=end_date,
        dry_run=dry_run,
    )


# ─── CLI Test ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if len(sys.argv) < 2:
        print("Usage: python deliver.py <html_file> [--dry-run]")
        print("Tests upload with Box Divvy config.")
        sys.exit(1)

    html_file = sys.argv[1]
    dry_run = "--dry-run" in sys.argv

    with open(html_file) as f:
        html_content = f.read()

    config = load_config()
    client = config["clients"][0]  # Box Divvy

    from data_fetcher import compute_date_range
    start, end = compute_date_range("last_7d")

    result = deliver_report_for_client(client, html_content, start, end, dry_run=dry_run)
    print(json.dumps(result, indent=2))
