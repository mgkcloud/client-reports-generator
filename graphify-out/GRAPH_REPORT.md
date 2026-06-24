# Graph Report - .  (2026-06-15)

## Corpus Check
- 19 files · ~0 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 272 nodes · 530 edges · 25 communities detected
- Extraction: 49% EXTRACTED · 51% INFERRED · 0% AMBIGUOUS · INFERRED: 272 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `generateReport()` - 30 edges
2. `ReportPipeline` - 16 edges
3. `get_campaign_insights()` - 12 edges
4. `get_adset_insights()` - 12 edges
5. `get_top_ads()` - 12 edges
6. `get_account_overview()` - 11 edges
7. `fetch_all_data()` - 10 edges
8. `coerce_account_ids()` - 9 edges
9. `formatCurrency()` - 9 edges
10. `wParagraph()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `main()` --calls--> `loadConfig()`  [INFERRED]
  /home/mgk/clawd/client-reports/generate_report.js → /home/mgk/clawd/client-reports/generate_report.js  _Bridges community 8 → community 1_
- `reconcileWeeklyChartDataWithWoo()` --calls--> `normaliseWooOrder()`  [INFERRED]
  /home/mgk/clawd/client-reports/generate_report.js → /home/mgk/clawd/client-reports/generate_report.js  _Bridges community 1 → community 10_
- `generateReport()` --calls--> `buildReconciledEcomOverviews()`  [INFERRED]
  /home/mgk/clawd/client-reports/generate_report.js → /home/mgk/clawd/client-reports/generate_report.js  _Bridges community 1 → community 6_
- `generateReport()` --calls--> `reconcileWeeklyChartDataWithWoo()`  [INFERRED]
  /home/mgk/clawd/client-reports/generate_report.js → /home/mgk/clawd/client-reports/generate_report.js  _Bridges community 10 → community 6_
- `fetchWooReconciliation()` --calls--> `formatCurrency()`  [INFERRED]
  /home/mgk/clawd/client-reports/generate_report.js → /home/mgk/clawd/client-reports/generate_report.js  _Bridges community 10 → community 9_

## Communities

### Community 0 - "Community 0"
Cohesion: 0.11
Nodes (43): account_id_label(), coerce_account_ids(), compute_date_range(), extract_content_text(), extract_conversions(), fetch_all_data(), get_account_overview(), get_adset_insights() (+35 more)

### Community 1 - "Community 1"
Cohesion: 0.12
Nodes (23): addDays(), buildReconciledEcomOverview(), buildReconciledEcomOverviews(), classifyWooOrder(), clientNeedsCurrencyRefresh(), computeDateRange(), dateOnly(), downloadFile() (+15 more)

### Community 2 - "Community 2"
Cohesion: 0.13
Nodes (12): compute_change(), fmt_currency(), fmt_number(), generate_recommendations(), main(), Returns client configs that need reports this week., Fill the HTML template with fetched data., Run the full pipeline for a single client. (+4 more)

### Community 3 - "Community 3"
Cohesion: 0.15
Nodes (21): extract_character_from_name(), fetch_adsets_performance(), fetch_campaign_performance(), generate_recommendations(), get_history_path(), get_trend(), load_config(), load_history() (+13 more)

### Community 4 - "Community 4"
Cohesion: 0.24
Nodes (13): convertActionValueArray(), currencyMultiplierForAccount(), detectConversionType(), fetchExchangeRateToReport(), getSourceCurrencies(), mergeBreakdownRows(), mergeDailyRows(), mergeOverviewRows() (+5 more)

### Community 5 - "Community 5"
Cohesion: 0.24
Nodes (14): buildCPLPanel(), buildCTRPanel(), buildDropoffPanel(), buildLeadsPanel(), fetchWeeklyData(), formatDate(), generateStackedChart(), getLocalDate() (+6 more)

### Community 6 - "Community 6"
Cohesion: 0.15
Nodes (14): buildDemographicInsights(), buildDropoffRows(), buildEcomDropoffRows(), buildLatestBatchMetrics(), buildTopAdsData(), fetchAdCreatedTimes(), fetchAdThumbnails(), formatDateRange() (+6 more)

### Community 7 - "Community 7"
Cohesion: 0.22
Nodes (12): deliver_report_for_client(), find_or_create_reports_folder(), generate_report_filename(), get_drive_service(), load_config(), Google Drive Report Delivery Uploads approved HTML reports to client folders on, Upload an HTML report to the client's Google Drive folder.      Args:         cl, Convenience function to deliver a report using client config. (+4 more)

### Community 8 - "Community 8"
Cohesion: 0.21
Nodes (12): extractContentText(), fetchBoxDivvyBrisbaneDrilldown(), generateCampaignDrilldownChart(), getAccountOverview(), getAccountOverviewDirect(), getDailyData(), getDemographics(), getDemographicsDirect() (+4 more)

### Community 9 - "Community 9"
Cohesion: 0.29
Nodes (12): appendDropoffSection(), buildDropoffDocxXml(), buildEcomDropoffDocxXml(), buildEcomFunnelDocxXml(), buildFunnelDocxXml(), buildGa4SourceMixDocxXml(), buildTableXml(), buildThreeColumnImageTableXml() (+4 more)

### Community 10 - "Community 10"
Cohesion: 0.22
Nodes (11): countBy(), fetchBoxDivvyPipedriveFunnel(), fetchWooReconciliation(), getSecret(), pipedrivePages(), pipedriveRequest(), reconcileWeeklyChartDataWithWoo(), summariseWooOrders() (+3 more)

### Community 11 - "Community 11"
Cohesion: 0.27
Nodes (5): Independent Report Validator Cross-validates report metrics using MULTIPLE indep, Validate a report using TWO independent sources:     1. Re-fetch account-level i, validate_metric(), validate_report(), ValidationResult

### Community 12 - "Community 12"
Cohesion: 0.38
Nodes (10): detectLatestBatch(), extractCanonicalConversionMetrics(), extractCanonicalCost(), fetchAdInsightsDirect(), getAllAds(), getAllAdsDirect(), getTopAds(), getTopAdsDirect() (+2 more)

### Community 13 - "Community 13"
Cohesion: 0.36
Nodes (8): buildAdTable(), buildConsolidatedMetricsTable(), buildDocumentXml(), documentOpen(), main(), para(), run(), xmlHeader()

### Community 14 - "Community 14"
Cohesion: 0.29
Nodes (7): addPngImageDrawingToDocx(), addPngImageToDocx(), appendBrisbaneDrilldownSection(), buildBrisbaneDrilldownDocxXml(), drilldownMetricRows(), escapeXml(), wCell()

### Community 15 - "Community 15"
Cohesion: 0.5
Nodes (4): docx_to_html(), docx_to_pdf_via_puppeteer(), Convert DOCX to HTML using mammoth      Args:         docx_path: Path to DOCX fi, Convert DOCX to PDF using mammoth + Puppeteer      Args:         docx_path: Path

### Community 16 - "Community 16"
Cohesion: 0.67
Nodes (0): 

### Community 17 - "Community 17"
Cohesion: 1.0
Nodes (0): 

### Community 18 - "Community 18"
Cohesion: 1.0
Nodes (0): 

### Community 19 - "Community 19"
Cohesion: 1.0
Nodes (0): 

### Community 20 - "Community 20"
Cohesion: 1.0
Nodes (0): 

### Community 21 - "Community 21"
Cohesion: 1.0
Nodes (0): 

### Community 22 - "Community 22"
Cohesion: 1.0
Nodes (0): 

### Community 23 - "Community 23"
Cohesion: 1.0
Nodes (0): 

### Community 24 - "Community 24"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **42 isolated node(s):** `Extract character type from ad or adset name.`, `Fetch adset-level performance breakdown.`, `Fetch campaign-level performance.`, `Aggregate performance by character type.`, `Generate markdown recommendations for next creative brief.` (+37 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 17`** (2 nodes): `list-campaigns.js`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 18`** (2 nodes): `test-demographics.js`, `testDemographics()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 19`** (2 nodes): `test-needlefree-account.js`, `testAccount()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 20`** (2 nodes): `test_chart_weeks.js`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 21`** (1 nodes): `create-ecom-template.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 22`** (1 nodes): `generate_pdf.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 23`** (1 nodes): `test-direct-api.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 24`** (1 nodes): `verify_weeks.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `generateReport()` connect `Community 6` to `Community 1`, `Community 8`, `Community 9`, `Community 10`, `Community 12`, `Community 14`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **Are the 29 inferred relationships involving `generateReport()` (e.g. with `getClientStartDate()` and `fetchBoxDivvyPipedriveFunnel()`) actually correct?**
  _`generateReport()` has 29 INFERRED edges - model-reasoned connections that need verification._
- **Are the 10 inferred relationships involving `get_campaign_insights()` (e.g. with `coerce_account_ids()` and `_merge_entity_rows()`) actually correct?**
  _`get_campaign_insights()` has 10 INFERRED edges - model-reasoned connections that need verification._
- **Are the 10 inferred relationships involving `get_adset_insights()` (e.g. with `coerce_account_ids()` and `_merge_entity_rows()`) actually correct?**
  _`get_adset_insights()` has 10 INFERRED edges - model-reasoned connections that need verification._
- **Are the 10 inferred relationships involving `get_top_ads()` (e.g. with `coerce_account_ids()` and `_merge_entity_rows()`) actually correct?**
  _`get_top_ads()` has 10 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Extract character type from ad or adset name.`, `Fetch adset-level performance breakdown.`, `Fetch campaign-level performance.` to the rest of the system?**
  _42 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.11 - nodes in this community are weakly interconnected._