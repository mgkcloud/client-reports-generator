# Campaign Start Dates Configuration

## Overview

The client report system now uses a **priority-based system** to determine campaign start dates for "All-time" metrics.

## Priority Order

1. **campaign_dates.json** (Highest Priority)
   - Explicit campaign start dates
   - Easy to maintain
   - Located: `/home/mgk/clawd/client-reports/campaign_dates.json`

2. **ugc_clients.json** (Fallback)
   - Uses first video batch date
   - May not reflect actual campaign start
   - Better than nothing, but not ideal

3. **60 Days Ago** (Last Resort)
   - Default fallback
   - System will warn you to add proper date

## How to Add/Update Campaign Dates

Edit `campaign_dates.json`:

```json
{
  "campaigns": [
    {
      "name": "Client Name",
      "account_id": "act_XXXXXXXX",
      "campaign_name": "Exact Campaign Name in Meta Ads",
      "start_date": "YYYY-MM-DD",
      "notes": "Optional description of when campaign actually launched"
    }
  ]
}
```

## Current Campaigns

| Client | Start Date | Campaign Name |
|--------|------------|---------------|
| Box Divvy | 2025-12-01 | Hubster Lead Gen – Melbourne |
| NeedleFree (Comfort-In) | 2025-12-15 | NeedleFree Lead Gen |

## Finding Actual Campaign Start Dates

1. **Google Drive Folders**: Check folder creation date
   - Box Divvy: https://drive.google.com/drive/folders/10i9oSE7WYXcMdxAn4CPDmQdfJvyi7Nqp
   - NeedleFree: https://drive.google.com/drive/folders/10tk5XWaqQpTX4hBXRom0OTPfd5O0Khh6

2. **Meta Ads Manager**: Check when first campaign was created

3. **Business Records**: Check contracts/onboarding dates

## How to Get Drive Folder Dates

```bash
# Using gcloud (if authenticated)
gcloud auth print-access-token | \
  curl -s "https://www.googleapis.com/drive/v3/files/FOLDER_ID?fields=name,createdTime" \
    -H "Authorization: Bearer $(cat)"
```

Replace `FOLDER_ID` with actual folder ID from config.
