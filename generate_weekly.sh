#!/bin/bash
# Weekly Client Report Generator
# Runs every Monday at 7:10 AM (after Google Ads optimizer at 7:05)
# Generates reports for all active clients

cd ~/clawd/client-reports

# Activate venv if exists
if [ -d "venv" ]; then
    source venv/bin/activate
fi

# Run the pipeline for all active clients
/usr/bin/python3 pipeline.py --all 2>&1 | tee -a /tmp/weekly-reports.log

echo "$(date): Weekly reports generated" >> /tmp/weekly-reports.log
