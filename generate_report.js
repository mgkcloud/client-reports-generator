#!/usr/bin/env node
/**
 * generate_report.js
 * 
 * Fetches Meta Ads data from Pipeboard API, generates a performance chart,
 * and fills the docxtemplater tagged template to produce a DOCX report.
 * 
 * Usage:
 *   node generate_report.js                          # Box Divvy, last 7 days
 *   node generate_report.js --client "Box Divvy"     # specific client
 *   node generate_report.js --since 2026-01-30 --until 2026-02-05
 *   node generate_report.js --client "NeedleFree"
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const ImageModule = require('docxtemplater-image-module-free');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { fetchWeeklyData, generateStackedChart } = require('./generate_chart');
const {
  normalizeAccountIds,
  normalizeCurrencyRow,
  normalizeCurrencyRows,
  currencyMultiplierForAccount,
  refreshCurrencyRatesToReport,
  mergeOverviewRows,
  mergeBreakdownRows,
  mergeDailyRows,
} = require('./account_merge_helpers');

// ─── Config ────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
const TEMPLATE_PATH = path.join(__dirname, 'template_tagged.docx');
const TEMPLATE_ECOM_PATH = path.join(__dirname, 'template_tagged_ecom.docx');
const REPORTS_DIR = path.join(__dirname, 'reports');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function clientNeedsCurrencyRefresh(clientConfig) {
  const targetCurrency = String(clientConfig.report_currency || 'AUD').trim().toUpperCase();
  const currencies = Object.values(clientConfig.account_currency || {})
    .map(v => String(v || targetCurrency).trim().toUpperCase());
  return currencies.some(currency => currency && currency !== targetCurrency);
}

async function refreshClientCurrencyRates(config, clientConfig) {
  if (!clientNeedsCurrencyRefresh(clientConfig)) return clientConfig;

  try {
    const refreshed = await refreshCurrencyRatesToReport(clientConfig);
    Object.assign(clientConfig, refreshed);
    const index = config.clients.findIndex(c => c.name === clientConfig.name);
    if (index >= 0) {
      config.clients[index] = { ...config.clients[index], ...refreshed };
      fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
    }
    const rates = Object.entries(refreshed.currency_rates_to_report || {})
      .map(([currency, rate]) => `${currency}=${Number(rate).toFixed(6)}`)
      .join(', ');
    console.log(`💱 Updated FX rates for ${clientConfig.name}: ${rates}`);
  } catch (err) {
    console.warn(`⚠️ Could not refresh FX rates; using configured fallback: ${err.message}`);
  }

  return clientConfig;
}

function getPipboardToken() {
  const config = loadConfig();
  const tokenFile = config.pipeboard_token_file.replace('~', process.env.HOME);
  return fs.readFileSync(tokenFile, 'utf8').trim();
}

function getSecret(name) {
  try {
    return execSync(`bash ${process.env.HOME}/clawd/scripts/secrets.sh get ${name}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (e) {
    return '';
  }
}

function sumActionValues(items = []) {
  const totals = {};
  if (!Array.isArray(items)) return totals;
  for (const item of items) {
    totals[item.action_type] = (totals[item.action_type] || 0) + Number(item.value || 0);
  }
  return totals;
}

function pickFirstTotal(totals, keys) {
  for (const key of keys) {
    if (Number(totals[key] || 0) > 0) return Number(totals[key] || 0);
  }
  return 0;
}

function extractCanonicalConversionMetrics(row) {
  const actionTotals = sumActionValues(row.actions);
  const purchase = pickFirstTotal(actionTotals, ['purchase', 'omni_purchase', 'web_in_store_purchase', 'offsite_conversion.fb_pixel_purchase']);
  const lead = Number(actionTotals.lead || 0);
  const conversionType = purchase > 0 ? 'purchase' : 'lead';
  const conversions = purchase > 0 ? purchase : lead;
  const valueTotals = sumActionValues(row.action_values);
  const revenue = purchase > 0
    ? pickFirstTotal(valueTotals, ['purchase', 'omni_purchase', 'web_in_store_purchase', 'offsite_conversion.fb_pixel_purchase'])
    : 0;
  return { conversions, revenue, conversionType };
}

function extractCanonicalCost(row, conversionType, spend, conversions) {
  const costTotals = sumActionValues(row.cost_per_action_type);
  const cost = conversionType === 'purchase'
    ? pickFirstTotal(costTotals, ['purchase', 'omni_purchase', 'web_in_store_purchase', 'offsite_conversion.fb_pixel_purchase'])
    : Number(costTotals.lead || 0);
  return cost || (conversions > 0 ? spend / conversions : 0);
}

function pipedriveRequest(token, endpoint, params = {}) {
  const url = new URL(`https://boxdivvy.pipedrive.com/api/v1${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  url.searchParams.set('api_token', token);

  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 60000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.success) return reject(new Error(parsed.error || parsed.error_info || 'Pipedrive request failed'));
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Pipedrive JSON parse failed: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function pipedrivePages(token, endpoint, params = {}) {
  const out = [];
  let start = 0;
  const limit = 500;
  while (true) {
    const result = await pipedriveRequest(token, endpoint, { ...params, start, limit });
    out.push(...(result.data || []));
    const pagination = result.additional_data && result.additional_data.pagination;
    if (!pagination || !pagination.more_items_in_collection) break;
    start = pagination.next_start;
  }
  return out;
}

function wooRequest(siteUrl, consumerKey, consumerSecret, endpoint, params = {}) {
  const url = new URL(`${siteUrl.replace(/\/$/, '')}/wp-json/wc/v3${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 60000,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'User-Agent': 'FeistyClientReports/1.0'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Woo ${endpoint} returned ${res.statusCode}: ${body.slice(0, 240)}`));
        }
        try {
          resolve({ data: JSON.parse(body), headers: res.headers });
        } catch (e) {
          reject(new Error(`Woo JSON parse failed: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Woo ${endpoint} timed out`)));
    req.on('error', reject);
  });
}

async function wooPages(siteUrl, consumerKey, consumerSecret, endpoint, params = {}) {
  const out = [];
  let page = 1;
  while (true) {
    const result = await wooRequest(siteUrl, consumerKey, consumerSecret, endpoint, { ...params, per_page: 100, page });
    out.push(...(Array.isArray(result.data) ? result.data : []));
    const totalPages = Number(result.headers['x-wp-totalpages'] || 0);
    if (!totalPages || page >= totalPages) break;
    page += 1;
  }
  return out;
}

function wooMetaMap(order) {
  const meta = {};
  for (const item of order.meta_data || []) {
    if (item && item.key) meta[item.key] = item.value;
  }
  return meta;
}

function pickMeta(meta, keys) {
  for (const key of keys) {
    const value = meta[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
  }
  return '';
}

function classifyWooOrder(order) {
  const meta = wooMetaMap(order);
  const source = [
    pickMeta(meta, ['_wc_order_attribution_utm_source', 'utm_source', 'source']),
    pickMeta(meta, ['_wc_order_attribution_source_type', 'source_type']),
    pickMeta(meta, ['_wc_order_attribution_referrer', 'referrer', '_referrer']),
    pickMeta(meta, ['_wc_order_attribution_utm_medium', 'utm_medium']),
    pickMeta(meta, ['_wc_order_attribution_utm_campaign', 'utm_campaign'])
  ].join(' ').toLowerCase();
  const fbc = pickMeta(meta, ['_fbc', 'fbc']);
  const fbclid = pickMeta(meta, ['fbclid', '_fbclid']);
  const gclid = pickMeta(meta, ['gclid', '_gclid']);

  if (fbclid || fbc || /facebook|instagram|fb\.com|ig\.com|meta|paid_social/.test(source)) return 'Meta / Facebook / Instagram';
  if (gclid || /google|organic search|cpc/.test(source)) return 'Google';
  if (/gmail|mail|email/.test(source)) return 'Email / Gmail';
  if (/direct|typein|typed|\(direct\)/.test(source) || !source.trim()) return 'Direct / unattributed';
  return 'Other / referral';
}

function normaliseWooOrder(order, productIds) {
  const productIdSet = new Set(productIds.map(Number));
  const kitItems = (order.line_items || []).filter(item => productIdSet.has(Number(item.product_id)));
  if (!kitItems.length) return null;
  const meta = wooMetaMap(order);
  return {
    id: order.id,
    status: order.status,
    date_paid: order.date_paid || order.date_completed || order.date_created,
    total: Number(order.total || 0),
    currency: order.currency || 'AUD',
    source: classifyWooOrder(order),
    meta,
    kit_items: kitItems.map(item => ({
      product_id: Number(item.product_id),
      name: item.name,
      quantity: Number(item.quantity || 0),
      total: Number(item.total || 0)
    }))
  };
}

function summariseWooOrders(orders, backendConfig, metaOverview = {}) {
  const productLabels = backendConfig.product_labels || {};
  const summary = {
    order_count: orders.length,
    revenue: orders.reduce((sum, order) => sum + (order.total || 0), 0),
    aov: 0,
    product_breakdown: {},
    contribution: {},
    meta_purchases: metaOverview.purchase_count || metaOverview.conversions || 0,
    meta_revenue: metaOverview.revenue || 0,
    meta_spend: metaOverview.spend || 0,
    backend_cpp: 0,
    backend_roas: 0,
    purchase_capture_rate: 0,
    value_capture_rate: 0,
    unattributed_revenue: 0,
    attribution_gap_orders: 0
  };

  for (const id of backendConfig.product_ids || []) {
    summary.product_breakdown[id] = { label: productLabels[String(id)] || String(id), units: 0, revenue: 0, orders: 0 };
  }

  for (const order of orders) {
    const seenProducts = new Set();
    summary.contribution[order.source] = summary.contribution[order.source] || { orders: 0, revenue: 0 };
    summary.contribution[order.source].orders += 1;
    summary.contribution[order.source].revenue += order.total || 0;
    for (const item of order.kit_items || []) {
      const bucket = summary.product_breakdown[item.product_id] || (summary.product_breakdown[item.product_id] = { label: String(item.product_id), units: 0, revenue: 0, orders: 0 });
      bucket.units += item.quantity || 0;
      bucket.revenue += item.total || 0;
      if (!seenProducts.has(item.product_id)) {
        bucket.orders += 1;
        seenProducts.add(item.product_id);
      }
    }
  }

  summary.aov = summary.order_count > 0 ? summary.revenue / summary.order_count : 0;
  summary.backend_cpp = summary.order_count > 0 ? summary.meta_spend / summary.order_count : 0;
  summary.backend_roas = summary.meta_spend > 0 ? summary.revenue / summary.meta_spend : 0;
  summary.purchase_capture_rate = summary.order_count > 0 ? summary.meta_purchases / summary.order_count * 100 : 0;
  summary.value_capture_rate = summary.revenue > 0 ? summary.meta_revenue / summary.revenue * 100 : 0;
  summary.unattributed_revenue = Math.max(0, summary.revenue - summary.meta_revenue);
  summary.attribution_gap_orders = summary.order_count - summary.meta_purchases;
  return summary;
}

function buildReconciledEcomOverview(metaOverview, wooSummary) {
  const out = { ...(metaOverview || {}) };
  if (!wooSummary || !wooSummary.order_count) return out;

  // Client-facing ecommerce reports use Meta for spend/traffic/upper funnel and
  // WooCommerce as the sales source of truth. This prevents known Purchase
  // tracking gaps from making the headline report understate actual sales while
  // still preserving Meta's spend, CTR, ATC, checkout, and ad-level diagnostics.
  out.conversions = wooSummary.order_count || 0;
  out.purchase_count = wooSummary.order_count || 0;
  out.cost_per_conversion = wooSummary.backend_cpp || 0;
  out.revenue = wooSummary.revenue || 0;
  out.roas = wooSummary.backend_roas || 0;
  out.reconciled = true;
  out.meta_reported_purchases = wooSummary.meta_purchases || 0;
  out.meta_reported_revenue = wooSummary.meta_revenue || 0;
  return out;
}

function buildReconciledEcomOverviews(overview, monthOverview, alltimeOverview, wooRecon) {
  if (!wooRecon || !wooRecon.ranges) {
    return { week: overview, month: monthOverview, alltime: alltimeOverview };
  }
  return {
    week: buildReconciledEcomOverview(overview, wooRecon.ranges.week && wooRecon.ranges.week.summary),
    month: buildReconciledEcomOverview(monthOverview, wooRecon.ranges.month && wooRecon.ranges.month.summary),
    alltime: buildReconciledEcomOverview(alltimeOverview, wooRecon.ranges.alltime && wooRecon.ranges.alltime.summary)
  };
}

function weekStartMonday(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  return d.toISOString().split('T')[0];
}

async function reconcileWeeklyChartDataWithWoo(clientConfig, weeklyData) {
  const backend = clientConfig.backend_sales;
  if (!backend || backend.type !== 'woocommerce' || !Array.isArray(weeklyData) || !weeklyData.length) return weeklyData;

  const consumerKey = getSecret(backend.consumer_key_secret);
  const consumerSecret = getSecret(backend.consumer_secret_secret);
  if (!consumerKey || !consumerSecret) return weeklyData;

  try {
    const sortedWeeks = [...weeklyData].filter(w => w.weekStart).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    if (!sortedWeeks.length) return weeklyData;
    const after = sortedWeeks[0].weekStart;
    const before = addDays(sortedWeeks[sortedWeeks.length - 1].weekStart, 6);
    const rawOrders = [];
    for (const status of backend.paid_statuses || ['processing', 'completed']) {
      rawOrders.push(...await wooPages(backend.site_url, consumerKey, consumerSecret, '/orders', {
        status,
        after: `${after}T00:00:00`,
        before: `${before}T23:59:59`
      }));
    }

    const unique = Array.from(new Map(rawOrders.map(o => [o.id, o])).values());
    const byWeek = new Map();
    for (const order of unique) {
      const normalised = normaliseWooOrder(order, backend.product_ids || []);
      if (!normalised) continue;
      const paidDate = String(normalised.date_paid || '').slice(0, 10);
      if (!paidDate) continue;
      const key = weekStartMonday(paidDate);
      if (!byWeek.has(key)) byWeek.set(key, { purchases: 0, revenue: 0 });
      const bucket = byWeek.get(key);
      bucket.purchases += 1;
      bucket.revenue += normalised.total || 0;
    }

    return weeklyData.map(row => {
      const woo = byWeek.get(row.weekStart);
      if (!woo) return row;
      const conversions = woo.purchases;
      const cpl = conversions > 0 ? (row.spend || 0) / conversions : 0;
      const roas = row.spend > 0 ? woo.revenue / row.spend : 0;
      return {
        ...row,
        purchases: woo.purchases,
        revenue: woo.revenue,
        conversions,
        cpl,
        roas,
        conversionType: 'purchase',
        chart_reconciled: true,
        meta_reported_purchases: row.purchases || row.conversions || 0,
        meta_reported_revenue: row.revenue || 0
      };
    });
  } catch (e) {
    console.warn(`  ⚠️ Weekly Woo chart reconciliation failed: ${e.message}`);
    return weeklyData;
  }
}

async function fetchWooReconciliation(clientConfig, ranges, metaByRange) {
  const backend = clientConfig.backend_sales;
  if (!backend || backend.type !== 'woocommerce') return null;
  const consumerKey = getSecret(backend.consumer_key_secret);
  const consumerSecret = getSecret(backend.consumer_secret_secret);
  if (!consumerKey || !consumerSecret) {
    console.warn('  ⚠️ Woo backend sales configured, but Woo secrets are missing');
    return null;
  }

  try {
    console.log('  🧾 Fetching WooCommerce backend sales truth...');
    const result = { ranges: {}, config: backend };
    for (const [label, range] of Object.entries(ranges)) {
      const statuses = backend.paid_statuses || ['processing', 'completed'];
      const rawOrders = [];
      for (const status of statuses) {
        rawOrders.push(...await wooPages(backend.site_url, consumerKey, consumerSecret, '/orders', {
          status,
          after: `${range.since}T00:00:00`,
          before: `${range.until}T23:59:59`
        }));
      }
      const unique = Array.from(new Map(rawOrders.map(o => [o.id, o])).values());
      const orders = unique.map(o => normaliseWooOrder(o, backend.product_ids || [])).filter(Boolean);
      result.ranges[label] = {
        since: range.since,
        until: range.until,
        orders,
        summary: summariseWooOrders(orders, backend, metaByRange[label] || {})
      };
      const s = result.ranges[label].summary;
      console.log(`  ✅ Woo ${label}: ${s.order_count} paid kit orders, ${formatCurrency(s.revenue)}, Meta purchases ${s.meta_purchases}`);
    }
    return result;
  } catch (e) {
    console.warn(`  ⚠️ Woo reconciliation failed: ${e.message}`);
    return null;
  }
}

function previousRange(range) {
  const since = new Date(`${range.since}T00:00:00Z`);
  const until = new Date(`${range.until}T00:00:00Z`);
  const days = Math.round((until - since) / 86400000) + 1;
  since.setUTCDate(since.getUTCDate() - days);
  until.setUTCDate(until.getUTCDate() - days);
  return {
    since: since.toISOString().split('T')[0],
    until: until.toISOString().split('T')[0]
  };
}

function formatDeltaPct(current, previous) {
  if (!previous && !current) return '0.0%';
  if (!previous) return 'new';
  return `${((current - previous) / previous * 100).toFixed(1)}%`;
}

function summariseGaRows(rows) {
  const out = { sessions: 0, users: 0, transactions: 0, revenue: 0 };
  for (const row of rows || []) {
    out.sessions += Number(row.sessions || 0);
    out.users += Number(row.users || 0);
    out.transactions += Number(row.transactions || 0);
    out.revenue += Number(row.revenue || 0);
  }
  return out;
}

function classifyGaSourceChannel(channel, sourceMedium) {
  const rawChannel = String(channel || '').trim();
  const sm = String(sourceMedium || '').toLowerCase();
  const isUnassigned = !rawChannel || /^(unassigned|\(not set\)|unknown)$/i.test(rawChannel);
  if (!isUnassigned) return rawChannel;

  if (/facebook|fb\b|instagram|ig\b|meta|l\.facebook|lm\.facebook/.test(sm)) {
    return /(cpc|paid|ads?|paidsocial|paid_social)/.test(sm) ? 'Paid Social' : 'Organic Social';
  }
  if (/google|bing|yahoo|duckduckgo/.test(sm)) {
    return /(cpc|ppc|paid|ads?)/.test(sm) ? 'Paid Search' : 'Organic Search';
  }
  if (/klaviyo|mail|email|newsletter|gmail/.test(sm)) return 'Email';
  if (/tiktok|pinterest|snapchat|linkedin|reddit/.test(sm)) return /(cpc|paid|ads?)/.test(sm) ? 'Paid Social' : 'Organic Social';
  if (/direct|\(direct\)|\(none\)/.test(sm)) return 'Direct';
  if (/referral/.test(sm)) return 'Referral';
  return null;
}

function normaliseGaSourceRows(rawRows, dateRangeName) {
  return (rawRows || [])
    .filter(row => row.dateRange === dateRangeName)
    .map(row => {
      const channel = classifyGaSourceChannel(row.channel, row.sourceMedium);
      if (!channel) return null;
      return {
        channel,
        source_medium: row.sourceMedium || '',
        sessions: Number(row.sessions || 0),
        users: Number(row.users || 0),
        transactions: Number(row.transactions || 0),
        revenue: Number(row.revenue || 0)
      };
    })
    .filter(Boolean);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function gaRangeLabel(range) {
  return `${range.since} → ${range.until}`;
}

async function fetchGa4SourceMix(clientConfig, ranges) {
  const analytics = clientConfig.analytics;
  if (!analytics || analytics.type !== 'ga4' || !analytics.property_id) return null;

  const week = ranges.week;
  const prev = previousRange(week);
  const month = ranges.month || { since: addDays(week.since, -29), until: week.until };
  const payload = {
    property_id: String(analytics.property_id).replace(/^properties\//, ''),
    service_account_secret: analytics.service_account_secret || 'google-sa',
    date_ranges: [
      { name: 'this_week', startDate: week.since, endDate: week.until },
      { name: 'prev_week', startDate: prev.since, endDate: prev.until },
      { name: 'last_month', startDate: month.since, endDate: month.until }
    ]
  };

  const script = String.raw`
import json, os, subprocess, sys
from google.oauth2 import service_account
from googleapiclient.discovery import build
params = json.load(sys.stdin)
sa = subprocess.check_output(['bash', os.path.expanduser('~/clawd/scripts/secrets.sh'), 'get', params.get('service_account_secret', 'google-sa')], text=True)
info = json.loads(sa)
creds = service_account.Credentials.from_service_account_info(info, scopes=['https://www.googleapis.com/auth/analytics.readonly'])
data = build('analyticsdata', 'v1beta', credentials=creds, cache_discovery=False)
rows = []
currency = None
timezone = None
for date_range in params['date_ranges']:
    body = {
      'dateRanges': [{'name': date_range['name'], 'startDate': date_range['startDate'], 'endDate': date_range['endDate']}],
      'dimensions': [{'name': 'sessionDefaultChannelGroup'}, {'name': 'sessionSourceMedium'}],
      'metrics': [{'name': 'sessions'}, {'name': 'totalUsers'}, {'name': 'transactions'}, {'name': 'purchaseRevenue'}],
      'orderBys': [{'metric': {'metricName': 'sessions'}, 'desc': True}],
      'limit': 1000
    }
    res = data.properties().runReport(property=f"properties/{params['property_id']}", body=body).execute()
    currency = currency or res.get('metadata', {}).get('currencyCode')
    timezone = timezone or res.get('metadata', {}).get('timeZone')
    for row in res.get('rows', []):
        dims = [d.get('value', '') for d in row.get('dimensionValues', [])]
        vals = [m.get('value', '0') for m in row.get('metricValues', [])]
        rows.append({
            'channel': dims[0] if len(dims) > 0 else '',
            'sourceMedium': dims[1] if len(dims) > 1 else '',
            'dateRange': date_range['name'],
            'sessions': int(float(vals[0])) if len(vals) > 0 else 0,
            'users': int(float(vals[1])) if len(vals) > 1 else 0,
            'transactions': int(float(vals[2])) if len(vals) > 2 else 0,
            'revenue': float(vals[3]) if len(vals) > 3 else 0.0,
        })
print(json.dumps({'rows': rows, 'currency': currency, 'timeZone': timezone}))
`;

  try {
    console.log('  📈 Fetching GA4 source mix...');
    const tmpScript = path.join('/tmp', `ga4-source-mix-${process.pid}-${Date.now()}.py`);
    fs.writeFileSync(tmpScript, script, { mode: 0o600 });
    let resultText;
    try {
      resultText = execSync(`python3 ${JSON.stringify(tmpScript)}`, {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 5
      }).trim();
    } finally {
      try { fs.unlinkSync(tmpScript); } catch (_) {}
    }
    const parsed = JSON.parse(resultText);
    const thisRows = normaliseGaSourceRows(parsed.rows, 'this_week');
    const prevRows = normaliseGaSourceRows(parsed.rows, 'prev_week');
    const monthRows = normaliseGaSourceRows(parsed.rows, 'last_month');
    const byChannel = {};
    for (const row of thisRows) {
      byChannel[row.channel] = byChannel[row.channel] || { channel: row.channel, current: { sessions: 0, users: 0, transactions: 0, revenue: 0 }, previous: { sessions: 0, users: 0, transactions: 0, revenue: 0 }, month: { sessions: 0, users: 0, transactions: 0, revenue: 0 } };
      byChannel[row.channel].current.sessions += row.sessions;
      byChannel[row.channel].current.users += row.users;
      byChannel[row.channel].current.transactions += row.transactions;
      byChannel[row.channel].current.revenue += row.revenue;
    }
    for (const row of prevRows) {
      byChannel[row.channel] = byChannel[row.channel] || { channel: row.channel, current: { sessions: 0, users: 0, transactions: 0, revenue: 0 }, previous: { sessions: 0, users: 0, transactions: 0, revenue: 0 }, month: { sessions: 0, users: 0, transactions: 0, revenue: 0 } };
      byChannel[row.channel].previous.sessions += row.sessions;
      byChannel[row.channel].previous.users += row.users;
      byChannel[row.channel].previous.transactions += row.transactions;
      byChannel[row.channel].previous.revenue += row.revenue;
    }
    for (const row of monthRows) {
      byChannel[row.channel] = byChannel[row.channel] || { channel: row.channel, current: { sessions: 0, users: 0, transactions: 0, revenue: 0 }, previous: { sessions: 0, users: 0, transactions: 0, revenue: 0 }, month: { sessions: 0, users: 0, transactions: 0, revenue: 0 } };
      byChannel[row.channel].month.sessions += row.sessions;
      byChannel[row.channel].month.users += row.users;
      byChannel[row.channel].month.transactions += row.transactions;
      byChannel[row.channel].month.revenue += row.revenue;
    }
    const channelRows = Object.values(byChannel).sort((a, b) => (b.current.revenue || b.current.sessions) - (a.current.revenue || a.current.sessions));
    const result = {
      property_id: payload.property_id,
      week,
      previous_week: prev,
      last_month: month,
      rows: channelRows,
      top_sources: thisRows.sort((a, b) => (b.revenue || b.sessions) - (a.revenue || a.sessions)).slice(0, 8),
      totals: { current: summariseGaRows(thisRows), previous: summariseGaRows(prevRows), month: summariseGaRows(monthRows) },
      currency: parsed.currency || 'AUD',
      timeZone: parsed.timeZone || 'Australia/Sydney'
    };
    const org = channelRows.find(row => row.channel === 'Organic Search');
    const paid = channelRows.find(row => row.channel === 'Paid Social');
    if (org) console.log(`  ✅ GA4 Organic Search: ${org.current.sessions} sessions, ${org.current.transactions} tx, ${formatCurrency(org.current.revenue)} (${formatDeltaPct(org.current.revenue, org.previous.revenue)} rev vs prior)`);
    if (paid) console.log(`  ✅ GA4 Paid Social: ${paid.current.sessions} sessions, ${paid.current.transactions} tx, ${formatCurrency(paid.current.revenue)} (${formatDeltaPct(paid.current.revenue, paid.previous.revenue)} rev vs prior)`);
    return result;
  } catch (e) {
    console.warn(`  ⚠️ GA4 source mix failed: ${e.message}`);
    return null;
  }
}

function getClientStartDate(clientName) {
  // Priority 1: Check campaign_dates.json for explicit start dates
  const CAMPAIGN_DATES_PATH = path.join(__dirname, 'campaign_dates.json');
  try {
    const campaignData = JSON.parse(fs.readFileSync(CAMPAIGN_DATES_PATH, 'utf-8'));
    const campaign = campaignData.campaigns.find(c =>
      c.name.toLowerCase().includes(clientName.toLowerCase()) ||
      clientName.toLowerCase().includes(c.name.toLowerCase())
    );

    if (campaign && campaign.start_date) {
      console.log(`  Using campaign start date from campaign_dates.json: ${campaign.start_date} (${campaign.notes || ''})`);
      return campaign.start_date;
    }
  } catch (err) {
    console.warn(`  Warning: Could not read campaign_dates.json: ${err.message}`);
  }

  // Priority 2: Fall back to UGC clients JSON (video production dates, not campaign start)
  const CLIENTS_JSON = path.join(process.env.HOME, 'code', 'life-os', 'clients', 'ugc_clients.json');
  try {
    const clientsData = JSON.parse(fs.readFileSync(CLIENTS_JSON, 'utf-8'));

    const client = clientsData.clients.find(c =>
      c.name.toLowerCase().includes(clientName.toLowerCase()) ||
      clientName.toLowerCase().includes(c.name.toLowerCase())
    );

    if (client && client.batches && client.batches.length > 0) {
      const firstBatch = client.batches[0];
      if (firstBatch.week_ending) {
        const weekEnding = new Date(firstBatch.week_ending);
        const monday = new Date(weekEnding);
        monday.setDate(monday.getDate() - 6);
        const date = monday.toISOString().split('T')[0];
        console.warn(`  Warning: Using video production date as fallback: ${date} (may not be actual campaign start)`);
        return date;
      }
    }
  } catch (err) {
    console.warn(`  Warning: Could not fetch client start date from UGC clients JSON: ${err.message}`);
  }

  // Priority 3: Default to 60 days ago
  const defaultDate = new Date();
  defaultDate.setDate(defaultDate.getDate() - 60);
  console.warn(`  Using default start date (60 days ago): ${defaultDate.toISOString().split('T')[0]}`);
  console.warn(`  Please add correct start date to campaign_dates.json for client: ${clientName}`);
  return defaultDate.toISOString().split('T')[0];
}

// ─── Pipeboard API ─────────────────────────────────────────────────────

function pipboardCall(toolName, args) {
  const config = loadConfig();
  const endpoint = new URL(config.pipeboard_endpoint);
  const token = getPipboardToken();

  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: args }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: endpoint.hostname,
      path: endpoint.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`Pipeboard error: ${json.error.message || JSON.stringify(json.error)}`));
          } else {
            resolve(json.result || json);
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data.substring(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(payload);
    req.end();
  });
}

function extractContentText(result) {
  if (result && result.content && Array.isArray(result.content)) {
    return result.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return JSON.stringify(result);
}

function parseInsightsJson(result) {
  const text = extractContentText(result);
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && typeof data === 'object') return [data];
    return [];
  } catch {
    console.warn('Could not parse insights JSON:', text.substring(0, 200));
    return [];
  }
}

// ─── Data Fetching ─────────────────────────────────────────────────────

async function getAccountOverview(accountId, since, until, campaignFilter = null) {
  const accountIds = normalizeAccountIds(accountId);
  if (accountIds.length > 1) {
    console.log(`  Fetching merged account overview for ${accountIds.length} accounts (${since} to ${until})${campaignFilter ? ` [campaign: ${campaignFilter}]` : ''}...`);
    const overviews = await Promise.all(accountIds.map(async id => normalizeCurrencyRow(await getAccountOverview(id, since, until, campaignFilter), id, accountId)));
    return mergeOverviewRows(overviews);
  }

  const singleAccountId = accountIds[0];
  console.log(`  Fetching account overview (${since} to ${until})${campaignFilter ? ` [campaign: ${campaignFilter}]` : ''}...`);

  const level = campaignFilter ? 'campaign' : 'account';
  const result = await pipboardCall('get_insights', {
    object_id: singleAccountId,
    time_range: { since, until },
    fields: 'spend,impressions,reach,clicks,cpm,cpc,ctr,actions,cost_per_action_type,action_values,campaign_name',
    level: level
  });

  const rows = parseInsightsJson(result);

  // If campaign filter is specified, filter the results to only include matching campaigns
  let filteredRows = rows;
  if (campaignFilter) {
    filteredRows = rows.filter(row => {
      const campaignName = row.campaign_name || '';
      return campaignName.toLowerCase().includes(campaignFilter.toLowerCase());
    });

    if (filteredRows.length === 0) {
      console.warn(`  Warning: No campaigns found matching "${campaignFilter}"`);
      console.warn(`  Available campaigns:`, rows.map(r => r.campaign_name).join(', '));
      return {};
    }

    // Aggregate data from multiple matching campaigns if needed
    if (filteredRows.length > 1) {
      console.log(`  Found ${filteredRows.length} campaigns matching filter, aggregating data...`);
    }
  }

  const row = filteredRows[0];
  if (!row) return {};

  // Aggregate data from all matching campaigns
  const aggregated = {
    spend: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    cpm: 0,
    cpc: 0,
    ctr: 0,
    conversions: 0,
    conversion_type: 'lead',
    cost_per_conversion: 0,
    roas: 0,
    revenue: 0,
    actions: [],
    cost_per_action_type: [],
    action_values: []
  };

  for (const r of filteredRows) {
    aggregated.spend += parseFloat(r.spend || 0);
    aggregated.impressions += parseInt(r.impressions || 0);
    aggregated.reach += parseInt(r.reach || 0);
    aggregated.clicks += parseInt(r.clicks || 0);

    // Merge actions
    if (Array.isArray(r.actions)) {
      aggregated.actions.push(...r.actions);
    }

    // Merge cost_per_action_type
    if (Array.isArray(r.cost_per_action_type)) {
      aggregated.cost_per_action_type.push(...r.cost_per_action_type);
    }

    // Merge action_values for Ads Manager purchase value / ROAS
    if (Array.isArray(r.action_values)) {
      aggregated.action_values.push(...r.action_values);
    }
  }

  // Calculate derived metrics
  aggregated.cpm = aggregated.impressions > 0 ? aggregated.spend / aggregated.impressions * 1000 : 0;
  aggregated.cpc = aggregated.clicks > 0 ? aggregated.spend / aggregated.clicks : 0;
  aggregated.ctr = aggregated.impressions > 0 ? aggregated.clicks / aggregated.impressions * 100 : 0;

  const overview = {
    spend: aggregated.spend,
    impressions: aggregated.impressions,
    reach: aggregated.reach,
    clicks: aggregated.clicks,
    cpm: aggregated.cpm,
    cpc: aggregated.cpc,
    ctr: aggregated.ctr,
    conversions: 0,
    completed_registrations: 0,
    completion_rate: 0,
    dropoff_count: 0,
    dropoff_rate: 0,
    conversion_type: 'lead',
    cost_per_conversion: 0,
    cost_per_completed_registration: 0,
    roas: 0,
    revenue: 0,
    // E-com funnel fields (Add to Cart → Checkout → Purchase)
    atc_count: 0,
    checkout_count: 0,
    purchase_count: 0
  };

  // Extract conversions (prioritize purchases, fallback to leads). Meta also returns
  // complete_registration aliases; use one canonical completed count, not an alias sum.
  const actionTotals = {};
  for (const action of aggregated.actions) {
    actionTotals[action.action_type] = (actionTotals[action.action_type] || 0) + parseInt(action.value || 0);
  }

  if (actionTotals.purchase) {
    overview.conversions = actionTotals.purchase;
    overview.conversion_type = 'purchase';
  } else if (actionTotals.lead) {
    overview.conversions = actionTotals.lead;
    overview.conversion_type = 'lead';
  }

  // E-com funnel: Add to Cart, Initiate Checkout, Purchase
  // Use canonical short names — Meta returns multiple aliases (fb_pixel, omni_, onsite_web_)
  // that all have the same count. The short name is the canonical aggregate.
  overview.atc_count = actionTotals['add_to_cart'] || 0;
  overview.checkout_count = actionTotals['initiate_checkout'] || 0;
  overview.purchase_count = actionTotals['purchase'] || 0;

  overview.completed_registrations = actionTotals.complete_registration
    || actionTotals['offsite_conversion.fb_pixel_complete_registration']
    || actionTotals.omni_complete_registration
    || 0;
  overview.dropoff_count = Math.max((actionTotals.lead || 0) - overview.completed_registrations, 0);
  overview.completion_rate = actionTotals.lead > 0 ? overview.completed_registrations / actionTotals.lead * 100 : 0;
  overview.dropoff_rate = actionTotals.lead > 0 ? overview.dropoff_count / actionTotals.lead * 100 : 0;
  overview.cost_per_completed_registration = overview.completed_registrations > 0 ? overview.spend / overview.completed_registrations : 0;

  // Extract cost per conversion
  for (const cost of aggregated.cost_per_action_type) {
    if (overview.conversion_type === 'purchase' && cost.action_type === 'purchase') {
      overview.cost_per_conversion = parseFloat(cost.value || 0);
      break;
    } else if (overview.conversion_type === 'lead' && cost.action_type === 'lead') {
      overview.cost_per_conversion = parseFloat(cost.value || 0);
      break;
    }
  }

  // Calculate ROAS for e-commerce from Meta action_values (Ads Manager purchase value)
  if (overview.conversion_type === 'purchase') {
    const valueTotals = {};
    for (const av of aggregated.action_values || []) {
      valueTotals[av.action_type] = (valueTotals[av.action_type] || 0) + parseFloat(av.value || 0);
    }
    overview.revenue = valueTotals['purchase'] || valueTotals['omni_purchase'] || valueTotals['offsite_conversion.fb_pixel_purchase'] || 0;
    overview.roas = overview.revenue > 0 ? overview.revenue / overview.spend : 0;
  }

  if (overview.conversions > 0 && overview.cost_per_conversion === 0) {
    overview.cost_per_conversion = overview.spend / overview.conversions;
  }

  return overview;
}

/**
 * Fetch account overview directly from Meta Graph API (bypasses Pipeboard).
 * Used as fallback when Pipeboard rate limit is hit.
 */
async function getAccountOverviewDirect(accountId, since, until, campaignFilter = null) {
  const accountIds = normalizeAccountIds(accountId);
  if (accountIds.length > 1) {
    console.log(`  Fetching merged overview directly from Meta API for ${accountIds.length} accounts (${since} to ${until})${campaignFilter ? ` [campaign: ${campaignFilter}]` : ''}...`);
    const overviews = await Promise.all(accountIds.map(async id => normalizeCurrencyRow(await getAccountOverviewDirect(id, since, until, campaignFilter), id, accountId)));
    return mergeOverviewRows(overviews);
  }

  const singleAccountId = accountIds[0];
  console.log(`  Fetching overview directly from Meta API (${since} to ${until})${campaignFilter ? ` [campaign: ${campaignFilter}]` : ''}...`);
  const fs = require('fs');
  const { execSync } = require('child_process');

  try {
    const token = fs.readFileSync(process.env.HOME + '/.secrets/meta-ads-token.txt', 'utf-8').trim();
    const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
    const level = campaignFilter ? 'campaign' : 'account';

    const url = `https://graph.facebook.com/v22.0/${singleAccountId}/insights?` +
      `access_token=${token}&` +
      `fields=spend,impressions,reach,clicks,cpm,cpc,ctr,actions,cost_per_action_type,action_values,campaign_name&` +
      `time_range=${timeRange}&` +
      `level=${level}&limit=200`;

    const rawResult = execSync(`curl -s --max-time 20 '${url}'`, { encoding: 'utf-8', timeout: 25000 });
    const result = JSON.parse(rawResult);

    if (result.error) {
      console.warn(`  ⚠️ Meta API error: ${result.error.message}`);
      return {};
    }

    let rows = result.data || [];
    if (campaignFilter) {
      rows = rows.filter(r => (r.campaign_name || '').toLowerCase().includes(campaignFilter.toLowerCase()));
      if (rows.length === 0) {
        console.warn(`  Warning: No campaigns matching "${campaignFilter}" via direct Meta API`);
        return {};
      }
    }

    // Aggregate across all matching rows
    const agg = { spend: 0, impressions: 0, reach: 0, clicks: 0, actions: [], cost_per_action_type: [], action_values: [] };
    for (const r of rows) {
      agg.spend += parseFloat(r.spend || 0);
      agg.impressions += parseInt(r.impressions || 0);
      agg.reach += parseInt(r.reach || 0);
      agg.clicks += parseInt(r.clicks || 0);
      if (Array.isArray(r.actions)) agg.actions.push(...r.actions);
      if (Array.isArray(r.cost_per_action_type)) agg.cost_per_action_type.push(...r.cost_per_action_type);
      if (Array.isArray(r.action_values)) agg.action_values.push(...r.action_values);
    }

    const overview = {
      spend: agg.spend,
      impressions: agg.impressions,
      reach: agg.reach,
      clicks: agg.clicks,
      cpm: agg.impressions > 0 ? agg.spend / agg.impressions * 1000 : 0,
      cpc: agg.clicks > 0 ? agg.spend / agg.clicks : 0,
      ctr: agg.impressions > 0 ? agg.clicks / agg.impressions * 100 : 0,
      conversions: 0,
      completed_registrations: 0,
      completion_rate: 0,
      dropoff_count: 0,
      dropoff_rate: 0,
      conversion_type: 'lead',
      cost_per_conversion: 0,
      cost_per_completed_registration: 0,
      roas: 0,
      revenue: 0,
      // E-com funnel fields
      atc_count: 0,
      checkout_count: 0,
      purchase_count: 0
    };

    // Aggregate conversions from action arrays
    const actionTotals = {};
    for (const a of agg.actions) {
      actionTotals[a.action_type] = (actionTotals[a.action_type] || 0) + parseInt(a.value || 0);
    }

    // Use 'purchase' as canonical (all variants report same count, don't double-count)
    if (actionTotals['purchase'] || actionTotals['omni_purchase']) {
      overview.conversions = actionTotals['purchase'] || actionTotals['omni_purchase'] || 0;
      overview.conversion_type = 'purchase';
    } else if (actionTotals['lead']) {
      overview.conversions = actionTotals['lead'];
      overview.conversion_type = 'lead';
    }

    // E-com funnel: Add to Cart, Initiate Checkout, Purchase
    // Use canonical short names — Meta returns multiple aliases with the same count
    overview.atc_count = actionTotals['add_to_cart'] || 0;
    overview.checkout_count = actionTotals['initiate_checkout'] || 0;
    overview.purchase_count = actionTotals['purchase'] || 0;

    overview.completed_registrations = actionTotals['complete_registration']
      || actionTotals['offsite_conversion.fb_pixel_complete_registration']
      || actionTotals['omni_complete_registration']
      || 0;
    overview.dropoff_count = Math.max((actionTotals['lead'] || 0) - overview.completed_registrations, 0);
    overview.completion_rate = actionTotals['lead'] > 0 ? overview.completed_registrations / actionTotals['lead'] * 100 : 0;
    overview.dropoff_rate = actionTotals['lead'] > 0 ? overview.dropoff_count / actionTotals['lead'] * 100 : 0;
    overview.cost_per_completed_registration = overview.completed_registrations > 0 ? agg.spend / overview.completed_registrations : 0;

    // Revenue for ecommerce
    const valueTotals = {};
    for (const av of agg.action_values) {
      valueTotals[av.action_type] = (valueTotals[av.action_type] || 0) + parseFloat(av.value || 0);
    }
    if (overview.conversion_type === 'purchase') {
      overview.revenue = valueTotals['purchase'] || valueTotals['omni_purchase'] || 0;
      overview.roas = overview.revenue > 0 && agg.spend > 0 ? overview.revenue / agg.spend : 0;
    }

    if (overview.conversions > 0) {
      overview.cost_per_conversion = agg.spend / overview.conversions;
    }

    console.log(`  ✅ Direct Meta overview: spend=$${overview.spend.toFixed(2)}, conversions=${overview.conversions}, type=${overview.conversion_type}`);
    return overview;
  } catch (e) {
    console.warn(`  ⚠️ Direct Meta API overview failed: ${e.message}`);
    return {};
  }
}

async function getTopAds(accountId, since, until, limit = 5, campaignFilter = null) {
  const accountIds = normalizeAccountIds(accountId);
  if (accountIds.length > 1) {
    console.log(`  Fetching top ads across ${accountIds.length} accounts...`);
    const adsByAccount = await Promise.all(accountIds.map(async id => normalizeCurrencyRows(await getTopAds(id, since, until, Math.max(limit, 20), campaignFilter), id, accountId)));
    return adsByAccount.flat()
      .filter(a => a.conversions > 0)
      .sort((a, b) => a.cpl - b.cpl)
      .slice(0, limit);
  }

  const singleAccountId = accountIds[0];
  console.log(`  Fetching ad-level insights from account...${campaignFilter ? ` [campaign: ${campaignFilter}]` : ''}`);
  // Get all ad-level insights in one call (much faster than per-ad)
  const result = await pipboardCall('get_insights', {
    object_id: singleAccountId,
    time_range: { since, until },
    fields: 'ad_id,ad_name,spend,impressions,clicks,ctr,actions,cost_per_action_type,action_values,campaign_name',
    level: 'ad'
  });
  const rows = parseInsightsJson(result);
  console.log(`  Found ${rows.length} ad insight rows`);

  const ads = [];
  for (const row of rows) {
    // Filter by campaign if specified
    if (campaignFilter) {
      const campaignName = row.campaign_name || '';
      if (!campaignName.toLowerCase().includes(campaignFilter.toLowerCase())) {
        continue;
      }
    }

    const adId = row.ad_id || '';
    const adName = row.ad_name || 'Unknown';
    const spend = parseFloat(row.spend || 0);
    if (spend === 0) continue;

    const { conversions, revenue, conversionType } = extractCanonicalConversionMetrics(row);
    const cpc = extractCanonicalCost(row, conversionType, spend, conversions);
    const roas = revenue > 0 ? revenue / spend : 0;

    ads.push({
      ad_id: adId,
      account_id: singleAccountId,
      ad_name: adName,
      campaign_name: row.campaign_name || '',
      spend,
      impressions: parseInt(row.impressions || 0),
      clicks: parseInt(row.clicks || 0),
      ctr: parseFloat(row.ctr || 0),
      conversions,
      cpl: cpc, // Keep as cpl for compatibility, but it's actually CPP for ecommerce
      roas,
      revenue,
      conversion_type: conversionType
    });
  }

  // Sort by cost per conversion ascending (best first), only include ads with conversions
  const withConversions = ads.filter(a => a.conversions > 0);
  withConversions.sort((a, b) => a.cpl - b.cpl);
  console.log(`  ${withConversions.length} ads with conversions${campaignFilter ? ` (filtered by campaign: ${campaignFilter})` : ''}, taking top ${limit}`);
  return withConversions.slice(0, limit);
}

/**
 * Fetch top ads directly from Meta Graph API (bypasses Pipeboard's 25-row limit).
 * Used for all-time top performers where complete data is critical.
 */
async function getTopAdsDirect(accountId, since, until, limit = 5, campaignFilter = null) {
  const accountIds = normalizeAccountIds(accountId);
  if (accountIds.length > 1) {
    console.log(`  Fetching all-time top ads directly across ${accountIds.length} accounts...`);
    const adsByAccount = await Promise.all(accountIds.map(async id => normalizeCurrencyRows(await getTopAdsDirect(id, since, until, Math.max(limit, 20), campaignFilter), id, accountId)));
    let merged = adsByAccount.flat().filter(Boolean).filter(a => a.conversions > 0);
    if (merged.length < limit) {
      console.log(`  ⚠️ Direct top-ad lookup returned ${merged.length}/${limit}; falling back to full ad scan across accounts...`);
      const allAds = await getAllAdsDirect(accountId, since, until, campaignFilter);
      merged = allAds.filter(a => a.conversions > 0);
    }
    merged.sort((a, b) => a.cpl - b.cpl);
    return merged.slice(0, limit);
  }

  const singleAccountId = accountIds[0];
  console.log(`  Fetching all-time top ads directly from Meta API (${since} to ${until})...`);
  const fs = require('fs');
  const { execSync } = require('child_process');

  try {
    const token = fs.readFileSync(process.env.HOME + '/.secrets/meta-ads-token.txt', 'utf-8').trim();
    const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
    
    // Fetch up to 200 ads with spend data, sorted by spend descending
    const url = `https://graph.facebook.com/v22.0/${singleAccountId}/insights?` +
      `access_token=${token}&` +
      `fields=ad_id,ad_name,spend,impressions,clicks,ctr,actions,cost_per_action_type,action_values,campaign_name&` +
      `time_range=${timeRange}&` +
      `level=ad&limit=200`;
    
    const rawResult = execSync(`curl -s --max-time 20 '${url}'`, { encoding: 'utf-8', timeout: 25000 });
    const result = JSON.parse(rawResult);

    if (result.error) {
      console.warn(`  ⚠️ Meta API error: ${result.error.message}`);
      return null; // Return null to signal fallback to Pipeboard
    }

    const rows = result.data || [];
    console.log(`  Found ${rows.length} ad insight rows from Meta API`);

    const ads = [];
    for (const row of rows) {
      if (campaignFilter) {
        const campaignName = row.campaign_name || '';
        if (!campaignName.toLowerCase().includes(campaignFilter.toLowerCase())) continue;
      }

      const spend = parseFloat(row.spend || 0);
      if (spend === 0) continue;

      const { conversions, revenue, conversionType } = extractCanonicalConversionMetrics(row);
      const cpl = extractCanonicalCost(row, conversionType, spend, conversions);

      ads.push({
        ad_id: row.ad_id || '',
        account_id: singleAccountId,
        ad_name: row.ad_name || 'Unknown',
        campaign_name: row.campaign_name || '',
        spend, impressions: parseInt(row.impressions || 0),
        clicks: parseInt(row.clicks || 0), ctr: parseFloat(row.ctr || 0),
        conversions, cpl, revenue, roas: revenue > 0 ? revenue / spend : 0,
        conversion_type: conversionType
      });
    }

    // Filter to ads with conversions, sort by cost per conversion ascending
    const withConversions = ads.filter(a => a.conversions > 0);
    withConversions.sort((a, b) => a.cpl - b.cpl);
    console.log(`  ✅ ${withConversions.length} ads with conversions from Meta API, taking top ${limit}`);
    return withConversions.slice(0, limit);
  } catch (e) {
    console.warn(`  ⚠️ Direct Meta API fetch failed: ${e.message}, falling back to Pipeboard`);
    return null;
  }
}

async function getAllAds(accountId, since, until, campaignFilter = null) {
  const accountIds = normalizeAccountIds(accountId);
  if (accountIds.length > 1) {
    console.log(`  Fetching ALL ad-level insights across ${accountIds.length} accounts...`);
    const adsByAccount = await Promise.all(accountIds.map(async id => normalizeCurrencyRows(await getAllAds(id, since, until, campaignFilter), id, accountId)));
    return adsByAccount.flat().sort((a, b) => b.spend - a.spend);
  }

  const singleAccountId = accountIds[0];
  console.log(`  Fetching ALL ad-level insights from account...${campaignFilter ? ` [campaign: ${campaignFilter}]` : ''}`);
  // Try Pipeboard first, fall back to direct Meta API
  let rows = [];
  try {
    const result = await pipboardCall('get_insights', {
      object_id: singleAccountId,
      time_range: { since, until },
      fields: 'ad_id,ad_name,spend,impressions,clicks,ctr,actions,cost_per_action_type,action_values,campaign_name',
      level: 'ad'
    });
    rows = parseInsightsJson(result);
  } catch (e) {
    console.warn(`  Warning: Pipeboard getAllAds failed: ${e.message}`);
  }

  // If Pipeboard returned nothing, fall back to direct Meta API
  if (rows.length === 0) {
    console.log('  Pipeboard returned empty for getAllAds, trying direct Meta API...');
    try {
      const directAds = await getAllAdsDirect(accountId, since, until, campaignFilter);
      console.log(`  Direct Meta API: ${directAds.length} ads for batch detection`);
      return directAds;
    } catch (e2) {
      console.warn(`  Warning: Direct Meta API getAllAds also failed: ${e2.message}`);
    }
  }
  console.log(`  Found ${rows.length} total ad insight rows`);

  const ads = [];
  for (const row of rows) {
    // Filter by campaign if specified
    if (campaignFilter) {
      const campaignName = row.campaign_name || '';
      if (!campaignName.toLowerCase().includes(campaignFilter.toLowerCase())) {
        continue;
      }
    }

    const adId = row.ad_id || '';
    const adName = row.ad_name || 'Unknown';
    const spend = parseFloat(row.spend || 0);
    if (spend === 0) continue;

    const { conversions, revenue, conversionType } = extractCanonicalConversionMetrics(row);
    const cpc = extractCanonicalCost(row, conversionType, spend, conversions);
    const roas = revenue > 0 ? revenue / spend : 0;

    ads.push({
      ad_id: adId,
      account_id: singleAccountId,
      ad_name: adName,
      campaign_name: row.campaign_name || '',
      spend,
      impressions: parseInt(row.impressions || 0),
      clicks: parseInt(row.clicks || 0),
      ctr: parseFloat(row.ctr || 0),
      conversions,
      cpl: cpc, // Keep as cpl for compatibility, but it's actually CPP for ecommerce
      roas,
      revenue,
      conversion_type: conversionType
    });
  }

  // Sort by spend descending (most recent/active first)
  ads.sort((a, b) => b.spend - a.spend);
  return ads;
}


/**
 * Direct Meta API fallback for getAllAds.
 * Fetches all ad-level insights directly from the Meta Graph API.
 */
async function getAllAdsDirect(accountId, since, until, campaignFilter = null) {
  const accountIds = normalizeAccountIds(accountId);
  if (accountIds.length > 1) {
    console.log(`  Fetching ALL ad insights directly across ${accountIds.length} accounts...`);
    const adsByAccount = await Promise.all(accountIds.map(async id => normalizeCurrencyRows(await getAllAdsDirect(id, since, until, campaignFilter), id, accountId)));
    return adsByAccount.flat().sort((a, b) => b.spend - a.spend);
  }

  const singleAccountId = accountIds[0];
  const fs = require('fs');
  const { execSync } = require('child_process');

  console.log('  Fetching ALL ad insights directly from Meta API...');
  const tokenFile = process.env.HOME + '/.secrets/meta-ads-token.txt';
  const token = fs.readFileSync(tokenFile, 'utf-8').trim();
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));

  const allRows = [];
  let url = `https://graph.facebook.com/v22.0/${singleAccountId}/insights?` +
    `access_token=${token}&` +
    `fields=ad_id,ad_name,spend,impressions,clicks,ctr,actions,cost_per_action_type,action_values,campaign_name&` +
    `level=ad&time_range=${timeRange}&limit=500`;

  while (url) {
    const raw = execSync(`curl -s --max-time 30 '${url}'`, { encoding: 'utf-8', timeout: 35000 });
    const result = JSON.parse(raw);
    if (result.error) throw new Error(`Meta API error: ${result.error.message}`);
    if (result.data) allRows.push(...result.data);
    url = result.paging && result.paging.next ? result.paging.next : null;
  }

  const ads = [];
  for (const row of allRows) {
    if (campaignFilter) {
      const campaignName = row.campaign_name || '';
      if (!campaignName.toLowerCase().includes(campaignFilter.toLowerCase())) continue;
    }
    const adId = row.ad_id || '';
    const adName = row.ad_name || 'Unknown';
    const spend = parseFloat(row.spend || 0);
    if (spend === 0) continue;

    const { conversions, revenue, conversionType } = extractCanonicalConversionMetrics(row);
    const cpc = extractCanonicalCost(row, conversionType, spend, conversions);
    const roas = revenue > 0 ? revenue / spend : 0;
    ads.push({
      ad_id: adId, account_id: singleAccountId, ad_name: adName, campaign_name: row.campaign_name || '',
      spend, impressions: parseInt(row.impressions || 0), clicks: parseInt(row.clicks || 0),
      ctr: parseFloat(row.ctr || 0), conversions, cpl: cpc, roas, revenue, conversion_type: conversionType
    });
  }
  ads.sort((a, b) => b.spend - a.spend);
  return ads;
}

async function getDemographicsDirect(accountId, since, until) {
  const accountIds = normalizeAccountIds(accountId);
  if (accountIds.length > 1) {
    const rows = (await Promise.all(accountIds.map(async id => normalizeCurrencyRows(await getDemographicsDirect(id, since, until), id, accountId)))).flat();
    return mergeBreakdownRows(rows, ['age', 'gender']);
  }

  const singleAccountId = accountIds[0];
  console.log('  Fetching demographics via direct Meta Ads API...');
  const fs = require('fs');
  const { execSync } = require('child_process');

  try {
    // Read Meta Ads access token (separate from Pipeboard token)
    const tokenFile = process.env.HOME + '/.secrets/meta-ads-token.txt';
    const token = fs.readFileSync(tokenFile, 'utf-8').trim();

    const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
    const url = `https://graph.facebook.com/v22.0/${singleAccountId}/insights?` +
      `access_token=${token}&` +
      `fields=spend,impressions,clicks,ctr,actions,cost_per_action_type,action_values&` +
      `breakdowns=age,gender&` +
      `time_range=${timeRange}&` +
      `level=account&limit=100`;

    // Use curl to avoid Node.js IPv6 timeout issues
    const rawResult = execSync(`curl -s --max-time 15 '${url}'`, { encoding: 'utf-8', timeout: 20000 });
    const result = JSON.parse(rawResult);

    if (result.error) {
      throw new Error(result.error.message);
    }

    if (!result.data || !Array.isArray(result.data)) {
      console.warn('  No data returned from direct API');
      return [];
    }

    console.log(`  ✅ Direct API returned ${result.data.length} demographic rows`);

    // Process the same way as Pipeboard data
    return result.data.map(row => {
      const spend = parseFloat(row.spend || 0);
      const { conversions, revenue, conversionType } = extractCanonicalConversionMetrics(row);
      const cpl = extractCanonicalCost(row, conversionType, spend, conversions);

      return {
        age: row.age || 'unknown',
        gender: row.gender || 'unknown',
        spend,
        impressions: parseInt(row.impressions || 0),
        clicks: parseInt(row.clicks || 0),
        ctr: parseFloat(row.ctr || 0),
        conversions,
        cpl,
        revenue,
        roas: revenue > 0 ? revenue / spend : 0,
        conversion_type: conversionType
      };
    }).filter(r => r.conversions > 0);
  } catch (e) {
    console.warn('  Direct API fetch failed:', e.message);
    return [];
  }
}

async function getDemographics(accountId, since, until) {
  const accountIds = normalizeAccountIds(accountId);
  if (accountIds.length > 1) {
    console.log(`  Fetching demographic breakdown across ${accountIds.length} accounts...`);
    const rows = (await Promise.all(accountIds.map(async id => normalizeCurrencyRows(await getDemographics(id, since, until), id, accountId)))).flat();
    return mergeBreakdownRows(rows, ['age', 'gender']);
  }

  const singleAccountId = accountIds[0];
  console.log('  Fetching demographic breakdown...');
  try {
    // Try breakdowns array format first
    const result = await pipboardCall('get_insights', {
      object_id: singleAccountId,
      time_range: { since, until },
      fields: 'spend,impressions,clicks,ctr,actions,cost_per_action_type,action_values,age,gender',
      level: 'account',
      breakdowns: ['age', 'gender']
    });
    const rows = parseInsightsJson(result);

    // Check if we got actual demographic breakdowns (rows should have age/gender fields)
    const hasBreakdowns = rows.some(r => r.age || r.gender);

    if (!hasBreakdowns) {
      console.warn('  Pipeboard API did not return demographic breakdowns, trying direct Meta Ads API...');
      return await getDemographicsDirect(singleAccountId, since, until);
    }

    return rows.map(row => {
      const spend = parseFloat(row.spend || 0);
      const { conversions, revenue, conversionType } = extractCanonicalConversionMetrics(row);
      const cpl = extractCanonicalCost(row, conversionType, spend, conversions);

      return {
        age: row.age || 'unknown',
        gender: row.gender || 'unknown',
        spend,
        impressions: parseInt(row.impressions || 0),
        clicks: parseInt(row.clicks || 0),
        ctr: parseFloat(row.ctr || 0),
        conversions,
        cpl,
        revenue,
        roas: revenue > 0 ? revenue / spend : 0,
        conversion_type: conversionType
      };
    }).filter(r => r.conversions > 0);
  } catch (e) {
    console.warn('  Warning: Demographics fetch failed:', e.message);
    return [];
  }
}

async function getDailyData(accountId, since, until, campaignFilter = null) {
  const accountIds = normalizeAccountIds(accountId);
  if (accountIds.length > 1) {
    console.log(`  Fetching daily breakdown across ${accountIds.length} accounts for chart...`);
    const rows = (await Promise.all(accountIds.map(async id => normalizeCurrencyRows(await getDailyData(id, since, until, campaignFilter), id, accountId)))).flat();
    return mergeDailyRows(rows);
  }

  const singleAccountId = accountIds[0];
  console.log('  Fetching daily breakdown for chart...');

  // Try Pipeboard first
  let rows = [];
  try {
    const result = await pipboardCall('get_insights', {
      object_id: singleAccountId,
      time_range: { since, until },
      fields: 'spend,impressions,clicks,ctr,actions,cost_per_action_type,campaign_name',
      level: campaignFilter ? 'campaign' : 'account',
      time_breakdown: 'day'
    });
    rows = parseInsightsJson(result);
    if (campaignFilter) {
      rows = rows.filter(r => (r.campaign_name || '').toLowerCase().includes(campaignFilter.toLowerCase()));
    }
  } catch (e) {
    console.warn('  Pipeboard daily data failed:', e.message);
  }

  // Fallback to direct Meta API if Pipeboard returned nothing
  if (rows.length === 0) {
    console.log('  ⚠️ Pipeboard returned no daily data, trying direct Meta API...');
    try {
      const fs = require('fs');
      const { execSync } = require('child_process');
      const token = fs.readFileSync(process.env.HOME + '/.secrets/meta-ads-token.txt', 'utf-8').trim();
      const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
      const level = campaignFilter ? 'campaign' : 'account';
      const url = `https://graph.facebook.com/v22.0/${singleAccountId}/insights?` +
        `access_token=${token}&` +
        `fields=spend,impressions,clicks,ctr,actions,cost_per_action_type,campaign_name&` +
        `time_range=${timeRange}&` +
        `level=${level}&time_increment=1&limit=500`;
      const raw = execSync(`curl -s --max-time 30 '${url}'`, { encoding: 'utf-8', timeout: 35000 });
      const result = JSON.parse(raw);
      if (result.error) {
        console.warn(`  ⚠️ Meta API daily data error: ${result.error.message}`);
      } else {
        rows = result.data || [];
        if (campaignFilter) {
          rows = rows.filter(r => (r.campaign_name || '').toLowerCase().includes(campaignFilter.toLowerCase()));
        }
        console.log(`  ✅ Got ${rows.length} daily rows from direct Meta API`);
      }
    } catch (e) {
      console.warn('  ⚠️ Direct Meta daily data also failed:', e.message);
    }
  }

  return rows.map(row => {
    const spend = parseFloat(row.spend || 0);
    const { conversions, conversionType } = extractCanonicalConversionMetrics(row);
    const cpl = extractCanonicalCost(row, conversionType, spend, conversions);

    return {
      date: row.date_start || row.date || '',
      spend,
      impressions: parseInt(row.impressions || 0),
      clicks: parseInt(row.clicks || 0),
      ctr: parseFloat(row.ctr || 0),
      conversions,
      cpl
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Chart Generation ──────────────────────────────────────────────────

async function generateChart(dailyData) {
  console.log('  Generating performance chart...');
  
  const width = 800;
  const height = 400;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, backgroundColour: 'white' });

  const labels = dailyData.map(d => {
    const date = new Date(d.date);
    return date.toLocaleDateString('en-AU', { month: 'short', day: 'numeric' });
  });

  const configuration = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: 'Leads',
          data: dailyData.map(d => d.conversions),
          backgroundColor: 'rgba(16, 185, 129, 0.7)',
          borderColor: 'rgba(16, 185, 129, 1)',
          borderWidth: 1,
          yAxisID: 'y',
          order: 2
        },
        {
          type: 'line',
          label: 'CPL ($)',
          data: dailyData.map(d => d.cpl > 0 ? d.cpl : null),
          borderColor: '#1E293B',
          backgroundColor: 'rgba(30, 41, 59, 0.1)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: '#1E293B',
          yAxisID: 'y1',
          tension: 0.3,
          order: 1
        },
        {
          type: 'line',
          label: 'Spend ($)',
          data: dailyData.map(d => d.spend),
          borderColor: '#6366F1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          borderWidth: 2,
          borderDash: [5, 5],
          pointRadius: 3,
          pointBackgroundColor: '#6366F1',
          yAxisID: 'y1',
          tension: 0.3,
          order: 1
        }
      ]
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: 'Daily Performance Overview',
          font: { size: 16, weight: 'bold' },
          color: '#1E293B',
          padding: { bottom: 20 }
        },
        legend: {
          position: 'bottom',
          labels: { font: { size: 12 }, color: '#475569', padding: 20 }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 }, color: '#475569' }
        },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          title: { display: true, text: 'Leads', color: '#10B981', font: { size: 12, weight: 'bold' } },
          grid: { color: 'rgba(0,0,0,0.05)' },
          ticks: { font: { size: 10 }, color: '#475569' },
          beginAtZero: true
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          title: { display: true, text: 'Cost ($)', color: '#1E293B', font: { size: 12, weight: 'bold' } },
          grid: { drawOnChartArea: false },
          ticks: { font: { size: 10 }, color: '#475569' },
          beginAtZero: true
        }
      }
    }
  };

  const buffer = await chartJSNodeCanvas.renderToBuffer(configuration);
  return buffer;
}

// ─── Thumbnail Fetching ────────────────────────────────────────────────

const THUMBNAILS_DIR = path.join(__dirname, 'thumbnails');
const PLACEHOLDER_PATH = path.join(THUMBNAILS_DIR, 'placeholder.png');

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : require('http');
    proto.get(url, { timeout: 15000 }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(destPath); });
      ws.on('error', reject);
    }).on('error', reject);
  });
}

async function generateAIInsights(overview, topAds, isEcommerce, clientName) {
  const fs = require('fs');
  const https = require('https');
  const { execSync } = require('child_process');

  // Read OpenRouter API key (handle both raw key and OPENROUTER_KEY= format)
  let apiKey = fs.readFileSync(process.env.HOME + '/.secrets/openrouter-key.txt', 'utf-8').trim();
  if (apiKey.startsWith('OPENROUTER_KEY=')) {
    apiKey = apiKey.split('=')[1].trim();
  }

  const conversionLabel = isEcommerce ? 'purchases' : 'leads';
  const costLabel = isEcommerce ? 'CPP' : 'CPL';

  // Prepare context for AI
  const context = {
    clientName,
    campaignType: isEcommerce ? 'e-commerce' : 'lead generation',
    period: 'last 7 days',
    metrics: {
      spend: `$${(overview.spend && overview.spend.toFixed(2)) || 0}`,
      conversions: overview.conversions || 0,
      costPerConversion: `$${(overview.cost_per_conversion || 0).toFixed(2)}`,
      ctr: `${(overview.ctr || 0).toFixed(2)}%`,
      impressions: overview.impressions || 0,
      clicks: overview.clicks || 0
    },
    topPerformers: topAds.slice(0, 3).map(ad => ({
      name: ad.ad_name,
      conversions: ad.conversions,
      cost: `$${ad.cpl.toFixed(2)}`,
      ctr: `${ad.ctr.toFixed(2)}%`
    }))
  };

  const prompt = `You are a Meta Ads expert generating insights for a client report. Use Australian English spelling (analyse, optimise, etc.).

Client: ${context.clientName}
Campaign Type: ${context.campaignType}
Period: ${context.period}

Metrics:
- Spend: ${context.metrics.spend}
- ${conversionLabel.charAt(0).toUpperCase() + conversionLabel.slice(1)}: ${context.metrics.conversions}
- Cost per ${conversionLabel}: ${context.metrics.costPerConversion}
- CTR: ${context.metrics.ctr}
- Impressions: ${context.metrics.impressions}
- Clicks: ${context.metrics.clicks}
${isEcommerce ? '- Revenue and ROAS are reconciled from WooCommerce paid kit orders where available. Treat these purchase/CPP numbers as the client-facing sales result, not raw Meta-only attribution. Do not call a CPP around $30 elevated or poor for this account; frame it as strong/viable unless other metrics clearly contradict it. Do not mention tracking gaps, under-reporting, Woo, reconciliation caveats, or attribution caveats in the public insights.' : ''}

Top Performers:
${context.topPerformers.map((ad, i) => `${i + 1}. ${ad.name}: ${ad.conversions} ${conversionLabel} at ${ad.cost} (${ad.ctr} CTR)`).join('\n')}

Generate JSON with these sections (be specific and actionable):
1. whatsWorking: 3-4 bullet points of what's performing well
2. opportunities: 3-4 bullet points of opportunities to improve
3. nextSteps: 3-4 bullet points of specific actions to take

Return ONLY valid JSON in this exact format:
{
  "whatsWorking": ["point 1", "point 2", "point 3"],
  "opportunities": ["point 1", "point 2", "point 3"],
  "nextSteps": ["point 1", "point 2", "point 3"]
}`;

  // Fallback chain: try each model in order
  const models = [
    'anthropic/claude-sonnet-4',
    'anthropic/claude-3.7-sonnet',
    'deepseek/deepseek-r1',
    'qwen/qwq-32b'
  ];

  for (const model of models) {
    try {
      console.log(`  Trying AI model: ${model}...`);
      const requestBody = JSON.stringify({
        model,
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 1000
      });

      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'openrouter.ai',
          path: '/api/v1/chat/completions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://feistyagency.com',
            'X-Title': 'Client Reports Generator'
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.error) {
                reject(new Error(json.error.message));
              } else if (json.choices && json.choices[0]) {
                const content = json.choices[0].message.content;
                // Extract JSON from markdown code blocks if present
                const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  resolve(JSON.parse(jsonMatch[1] || jsonMatch[0]));
                } else {
                  resolve(JSON.parse(content));
                }
              } else {
                reject(new Error('No response from API'));
              }
            } catch (e) {
              reject(new Error(`Failed to parse API response: ${e.message}`));
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(new Error('Request timeout')); });
        req.write(requestBody);
        req.end();
      });

      console.log(`  \u2705 AI insights generated with ${model}`);
      return result;
    } catch (e) {
      console.warn(`  \u26a0\ufe0f ${model} failed: ${e.message}`);
      // Continue to next model
    }
  }

  // All models failed - return context-aware fallback
  console.warn('  All AI models failed, using data-driven fallback insights');
  return {
    whatsWorking: [
      `${overview.conversions || 0} ${conversionLabel} generated from $${(overview.spend || 0).toFixed(2)} spend`,
      `CTR of ${(overview.ctr || 0).toFixed(2)}% indicates strong ad relevance`,
      ...(overview.conversions > 0 ? [`Cost per ${conversionLabel.slice(0, -1)} of $${(overview.cost_per_conversion || 0).toFixed(2)} is within viable range`] : []),
      ...(topAds.length > 0 ? [`Top performer "${topAds[0].ad_name}" driving ${topAds[0].conversions} ${conversionLabel}`] : [])
    ],
    opportunities: [
      `Reduce CPL by pausing ads with CTR below ${(overview.ctr || 0).toFixed(1)}% average`,
      ...(overview.conversions < 50 ? ['Scale spend on winning ad creatives to increase volume'] : []),
      'Create new ad variations based on top-performing creative patterns',
      'Expand audience targeting based on demographic insights'
    ],
    nextSteps: [
      `Increase budget on top ${Math.min(topAds.length, 2)} performers by 20-30%`,
      'Review underperforming ads and pause or refresh creative',
      'Set up A/B experiment for new headline or creative variation',
      'Monitor frequency caps to avoid ad fatigue'
    ]
  };
}


/**
 * Direct Meta API fallback for thumbnail fetching.
 * Fetches ad creative thumbnail_url directly from the Meta Graph API.
 */
async function fetchThumbnailDirect(adId, localPath, thumbnailMap) {
  const fs = require('fs');
  const { execSync } = require('child_process');
  try {
    const token = fs.readFileSync(process.env.HOME + '/.secrets/meta-ads-token.txt', 'utf-8').trim();
    // First get the creative ID for this ad
    const creativeUrl = `https://graph.facebook.com/v22.0/${adId}?access_token=${token}&fields=creative`;
    const creativeRaw = execSync(`curl -s --max-time 10 '${creativeUrl}'`, { encoding: 'utf-8', timeout: 15000 });
    const creativeData = JSON.parse(creativeRaw);
    if (creativeData.creative && creativeData.creative.id) {
      const creativeId = creativeData.creative.id;
      const thumbUrl = `https://graph.facebook.com/v22.0/${creativeId}?access_token=${token}&fields=thumbnail_url`;
      const thumbRaw = execSync(`curl -s --max-time 10 '${thumbUrl}'`, { encoding: 'utf-8', timeout: 15000 });
      const thumbData = JSON.parse(thumbRaw);
      if (thumbData.thumbnail_url) {
        await downloadFile(thumbData.thumbnail_url, localPath);
        thumbnailMap[adId] = localPath;
        return;
      }
    }
    thumbnailMap[adId] = PLACEHOLDER_PATH;
  } catch (e) {
    console.warn(`    Warning: Direct API thumbnail also failed for ad ${adId}: ${e.message}`);
    thumbnailMap[adId] = PLACEHOLDER_PATH;
  }
}

async function fetchAdThumbnails(adIds) {
  if (!fs.existsSync(THUMBNAILS_DIR)) fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });

  const thumbnailMap = {};
  const BATCH_SIZE = 5;
  const DELAY_MS = 500;

  console.log(`  🖼️  Fetching thumbnails for ${adIds.length} ads...`);

  for (let i = 0; i < adIds.length; i += BATCH_SIZE) {
    const batch = adIds.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (adId) => {
      const localPath = path.join(THUMBNAILS_DIR, `${adId}.jpg`);

      // Use cached thumbnail if it exists and is recent (< 24h old)
      if (fs.existsSync(localPath)) {
        const stat = fs.statSync(localPath);
        const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
        if (ageHours < 24 && stat.size > 100) {
          thumbnailMap[adId] = localPath;
          return;
        }
      }

      try {
          const result = await pipboardCall('get_ad_creatives', {
            ad_id: adId,
            fields: 'thumbnail_url'
          });
          const text = extractContentText(result);
          const parsed = JSON.parse(text);
          const creatives = parsed.data || (Array.isArray(parsed) ? parsed : []);

          if (creatives.length > 0 && creatives[0].thumbnail_url) {
            await downloadFile(creatives[0].thumbnail_url, localPath);
            thumbnailMap[adId] = localPath;
          } else {
            // No creatives from Pipeboard, try direct Meta API
            await fetchThumbnailDirect(adId, localPath, thumbnailMap);
          }
        } catch (pipeErr) {
          // Pipeboard failed, fall back to direct Meta API
          console.warn(`    Pipeboard thumbnail failed for ad ${adId}: ${pipeErr.message}, trying direct API...`);
          await fetchThumbnailDirect(adId, localPath, thumbnailMap);
        }
    });

    await Promise.all(promises);

    // Delay between batches to avoid rate limits
    if (i + BATCH_SIZE < adIds.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  const fetched = Object.values(thumbnailMap).filter(p => p !== PLACEHOLDER_PATH).length;
  console.log(`  ✅ Thumbnails: ${fetched} fetched, ${Object.keys(thumbnailMap).length - fetched} placeholders`);
  return thumbnailMap;
}

// ─── Report Data Assembly ──────────────────────────────────────────────

function formatCurrency(val) {
  return '$' + val.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatPct(val) {
  return val.toFixed(2) + '%';
}

function guessReleaseLot(adName) {
  // Try to extract date-based release lot from ad name
  // Order matters: most specific patterns first

  // Full date patterns (DD-MM-YYYY or YYYY-MM-DD)
  const fullDatePatterns = [
    /(\d{4}[-_]\d{2}[-_]\d{2})/,           // e.g., "2026-01-29"
    /(\d{1,2}[-_]\d{1,2}[-_]\d{4})/,       // e.g., "23-11-2025", "22-12-2025"
  ];
  for (const p of fullDatePatterns) {
    const m = adName.match(p);
    if (m) {
      // Convert DD-MM-YYYY to readable month format
      const parts = m[1].split(/[-_]/);
      if (parts.length === 3) {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        if (parts[0].length === 4) {
          // YYYY-MM-DD
          const monthIdx = parseInt(parts[1]) - 1;
          if (monthIdx >= 0 && monthIdx < 12) return `${months[monthIdx]}-${parts[2]}`;
        } else if (parts[2].length === 4) {
          // DD-MM-YYYY
          const monthIdx = parseInt(parts[1]) - 1;
          if (monthIdx >= 0 && monthIdx < 12) return `${months[monthIdx]}-${parts[0]}`;
        }
      }
      return m[1];
    }
  }

  // Month name patterns (e.g., "Jan-29", "Dec-15", "29-Jan")
  const monthNamePatterns = [
    /(\w{3}[-_]\d{1,2})(?!\d)/i,  // e.g., "Jan-29", "Dec-15" (not followed by more digits)
    /(\d{1,2}[-_](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))/i,  // e.g., "29-Jan"
  ];
  for (const p of monthNamePatterns) {
    const m = adName.match(p);
    if (m) return m[1];
  }

  return 'General';
}

function generateExecutiveSummary(overview, topAds, clientName, isEcommerce = false, wooRecon = null) {
  const conversions = overview.conversions || 0;
  const costPerConversion = overview.cost_per_conversion || 0;
  const spend = overview.spend || 0;
  const ctr = overview.ctr || 0;
  const bestCost = topAds.length > 0 ? topAds[0].cpl : 0;
  const bestAdName = topAds.length > 0 ? topAds[0].ad_name : '';

  const wooWeek = wooRecon && wooRecon.ranges && wooRecon.ranges.week && wooRecon.ranges.week.summary;
  if (isEcommerce && wooWeek) {
    const backendCpp = wooWeek.order_count > 0 ? formatCurrency(wooWeek.backend_cpp || 0) : '—';
    const backendRoas = wooWeek.meta_spend > 0 ? `${(wooWeek.backend_roas || 0).toFixed(2)}x` : '—';
    return `${clientName} generated ${wooWeek.order_count || 0} reconciled purchases and ${formatCurrency(wooWeek.revenue || 0)} in revenue for the period. Total spend was ${formatCurrency(wooWeek.meta_spend || spend)}, producing a ${backendCpp} cost per purchase and ${backendRoas} ROAS. Average CTR was ${formatPct(ctr)}, with strong click volume and confirmed paid kit sales through WooCommerce.`;
  }

  const conversionLabel = isEcommerce ? 'purchases' : 'leads';
  const costLabel = isEcommerce ? 'CPP' : 'CPL';
  const campaignType = isEcommerce ? 'e-commerce' : 'lead gen';

  let summary = `The ${clientName} campaign is delivering `;
  if (costPerConversion < 10) {
    summary += `strong performance with a blended ${costLabel} of ${formatCurrency(costPerConversion)} across ${conversions} ${conversionLabel}. `;
  } else if (costPerConversion < 20) {
    summary += `solid results with a blended ${costLabel} of ${formatCurrency(costPerConversion)} across ${conversions} ${conversionLabel}. `;
  } else {
    summary += `results with a blended ${costLabel} of ${formatCurrency(costPerConversion)} across ${conversions} ${conversionLabel}. `;
  }

  summary += `Total ad spend for the period was ${formatCurrency(spend)} with an average CTR of ${formatPct(ctr)}. `;

  if (topAds.length > 0) {
    summary += `The top performer achieved a ${costLabel} of ${formatCurrency(bestCost)}`;
    if (bestAdName) summary += ` (${bestAdName.substring(0, 40)})`;
    summary += '. ';
  }

  if (ctr > 5) {
    summary += 'High CTR indicates strong creative-audience fit. ';
  } else if (ctr > 2) {
    summary += `CTR is within healthy range for ${campaignType} campaigns. `;
  }

  return summary.trim();
}

function buildDemographicInsights(demoData) {
  if (!demoData.length) {
    return [{ title: 'Data pending', description: 'Demographic breakdown requires more data volume' }];
  }

  // Sort by conversions descending
  const sorted = [...demoData].sort((a, b) => b.conversions - a.conversions);

  // Group by gender
  const genderGroups = {};
  for (const d of sorted) {
    const gender = d.gender === 'female' ? 'Female' : d.gender === 'male' ? 'Male' : 'Unknown';
    const key = `${gender} ${d.age}`;
    if (!genderGroups[key]) genderGroups[key] = { ...d, label: key };
    else {
      genderGroups[key].conversions += d.conversions;
      genderGroups[key].spend += d.spend;
    }
  }

  const top = Object.values(genderGroups)
    .sort((a, b) => b.conversions - a.conversions)
    .slice(0, 3);

  // Determine if e-commerce or lead gen from first item
  const isEcommerce = sorted[0] && sorted[0].conversion_type === 'purchase';
  const conversionLabel = isEcommerce ? 'purchases' : 'leads';
  const costLabel = isEcommerce ? 'CPP' : 'CPL';

  return top.map(d => ({
    title: d.label,
    description: `${d.conversions} ${conversionLabel}, ${formatCurrency(d.cpl)} ${costLabel}, ${formatPct(d.ctr)} CTR`
  }));
}

function buildTopAdsData(topAds, thumbnailMap = {}, adCreatedTimes = {}) {
  const rankIcons = ['🔥', '2', '⭐', '4', '5'];
  return topAds.map((ad, i) => {
    // Use created_time from Meta API if available, otherwise fall back to name parsing
    let releaseLot = guessReleaseLot(ad.ad_name);
    const createdTime = adCreatedTimes[ad.ad_id];
    if (createdTime) {
      const d = new Date(createdTime);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      releaseLot = `${months[d.getMonth()]}-${d.getDate()}`;
    }
    // When no conversions yet (new batch), show spend in CPL/CPP column and "—" for count
    const hasConversions = ad.conversions > 0;
    return {
      rank_icon: rankIcons[i] || String(i + 1),
      release_lot: releaseLot,
      cpl: hasConversions ? formatCurrency(ad.cpl) : (ad.spend > 0 ? `${formatCurrency(ad.spend)} spent` : '—'),
      leads: hasConversions ? String(ad.conversions) : (ad.spend > 0 ? 'Pending' : '—'),
      ctr: formatPct(ad.ctr),
      ad_id: '...' + ad.ad_id.slice(-9),
      thumbnail: thumbnailMap[ad.ad_id] || PLACEHOLDER_PATH
    };
  });
}

function buildDropoffRows(overview, monthOverview, alltimeOverview) {
  const rows = [
    ['This Week', overview],
    ['Last 30 Days', monthOverview],
    ['Campaign to Date', alltimeOverview],
  ];
  return rows.map(([period, ov]) => {
    const leads = ov.conversions || 0;
    const completed = ov.completed_registrations || 0;
    const dropoff = ov.dropoff_count != null ? ov.dropoff_count : Math.max(leads - completed, 0);
    const completionRate = ov.completion_rate || (leads > 0 ? completed / leads * 100 : 0);
    return {
      period,
      meta_leads: String(leads),
      completed_applications: String(completed),
      dropoff: String(dropoff),
      completion_rate: formatPct(completionRate),
      cost_per_completed: completed > 0 ? formatCurrency((ov.spend || 0) / completed) : '—'
    };
  });
}

function buildEcomDropoffRows(overview, monthOverview, alltimeOverview) {
  const rows = [
    ['This Week', overview],
    ['Last 30 Days', monthOverview],
    ['Campaign to Date', alltimeOverview],
  ];
  return rows.map(([period, ov]) => {
    const atc = ov.atc_count || 0;
    const checkout = ov.checkout_count || 0;
    const purchase = ov.purchase_count || 0;
    // Client-facing reports should not present Meta's attributed ATC and Checkout
    // events as a literal ordered funnel. Use the larger pre-purchase intent
    // signal so the table remains monotonic and useful after BOF/TOF restructuring.
    const shoppingIntent = Math.max(atc, checkout);
    const intentToPurchase = shoppingIntent > 0 ? (purchase / shoppingIntent * 100) : 0;
    const purchaseToAtc = atc > 0 ? (purchase / atc * 100) : 0;
    return {
      period,
      shopping_intent: String(shoppingIntent),
      add_to_cart: String(atc),
      checkout: String(checkout),
      purchase: String(purchase),
      intent_to_purchase_rate: formatPct(intentToPurchase),
      atc_to_purchase_rate: formatPct(purchaseToAtc),
    };
  });
}

function dateOnly(value) {
  return (value || '').slice(0, 10);
}

function isDateInRange(value, since, until) {
  const d = dateOnly(value);
  return d && d >= since && d <= until;
}

function countBy(items, fn) {
  const counts = {};
  for (const item of items) {
    const key = fn(item) || 'Unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function topEntries(counts, limit = 5) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

async function fetchBoxDivvyPipedriveFunnel(since, until, overview) {
  const token = getSecret('pipedrive-boxdivvy');
  if (!token) return null;

  try {
    console.log('  🔗 Fetching direct Pipedrive funnel for BoxDivvy...');
    const [pipelinesResp, stagesResp, deals] = await Promise.all([
      pipedriveRequest(token, '/pipelines'),
      pipedriveRequest(token, '/stages'),
      pipedrivePages(token, '/deals', { status: 'all_not_deleted' })
    ]);

    const pipelines = Object.fromEntries((pipelinesResp.data || []).map(p => [p.id, p]));
    const stages = Object.fromEntries((stagesResp.data || []).map(s => [s.id, s]));
    const corePipelineIds = [1, 2, 3];
    const coreDeals = deals.filter(d => corePipelineIds.includes(d.pipeline_id));
    const created = coreDeals.filter(d => isDateInRange(d.add_time, since, until));
    const lost = coreDeals.filter(d => isDateInRange(d.lost_time, since, until));
    const openNow = coreDeals.filter(d => d.status === 'open');

    const stageName = (deal) => stages[deal.stage_id] && stages[deal.stage_id].name || 'Unknown';
    const pipelineName = (deal) => pipelines[deal.pipeline_id] && pipelines[deal.pipeline_id].name || 'Unknown';
    const createdByStage = countBy(created, stageName);
    const openByStage = countBy(openNow, stageName);
    const lostReasons = countBy(lost, d => d.lost_reason || 'No reason');
    const metaLeads = overview.conversions || 0;
    const completed = overview.completed_registrations || 0;
    const crmCreated = created.length;
    const firstCall = createdByStage['First Call Completed'] || 0;
    const crmApplicationSubmitted = createdByStage['Application Submitted'] || 0;
    // Client-facing funnel must use denominator-compatible steps. The Pipedrive
    // Application Submitted swim lane can include organic/imported/older Meta leads,
    // so it can exceed Meta leads in the selected report window. Use Meta's
    // complete_registration event for the application step, and keep CRM stage
    // counts internal/open-swim-lane only.
    const applicationSubmitted = completed;

    const stageRows = [
      { stage: 'Meta Leads', count: metaLeads, source: 'Meta canonical lead', notes: 'Top-funnel ad-attributed leads' },
      { stage: 'Application Submitted', count: applicationSubmitted, source: 'Meta complete_registration', notes: 'Ad-attributed submitted applications' },
      { stage: 'First Call Completed', count: firstCall, source: 'Pipedrive swim lane', notes: 'CRM deals that reached the first-call-completed lane during the period' },
    ];

    return {
      period: { since, until },
      stageRows,
      createdByStage,
      openByStage,
      lostReasons,
      createdTotal: crmCreated,
      openTotal: openNow.length,
      lostTotal: lost.length,
      byPipeline: countBy(created, pipelineName),
      chart: {
        title: 'Full Funnel: Meta → Pipedrive Swim Lanes',
        subtitle: `${since} to ${until} · BoxDivvy Hubster Recruitment`,
        stages: stageRows.map(r => ({ label: r.stage, value: r.count })),
        notes: [
          `Application submitted: ${applicationSubmitted}`,
          `First call completed: ${firstCall}`
        ],
        lossSummary: []
      }
    };
  } catch (e) {
    console.warn(`  ⚠️ Pipedrive funnel fetch failed: ${e.message}`);
    return null;
  }
}

/** Escape text for raw WordprocessingML insertion. */
function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wParagraph(text, style = {}) {
  const bold = style.bold ? '<w:b/>' : '';
  const size = style.size ? `<w:sz w:val="${style.size}"/>` : '';
  const color = style.color ? `<w:color w:val="${style.color}"/>` : '';
  const spacing = style.spacing ? `<w:pPr><w:spacing w:before="${style.spacing}" w:after="120"/></w:pPr>` : '';
  return `<w:p>${spacing}<w:r><w:rPr>${bold}${size}${color}</w:rPr><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}

function wCell(text, header = false) {
  const fill = header ? '<w:shd w:fill="1A1A2E"/>' : '';
  const color = header ? '<w:color w:val="FFFFFF"/>' : '';
  const bold = header ? '<w:b/>' : '';
  return `<w:tc><w:tcPr><w:tcW w:w="1700" w:type="dxa"/>${fill}</w:tcPr><w:p><w:r><w:rPr>${bold}${color}</w:rPr><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:tc>`;
}

function buildTableXml(header, rows) {
  const tableRows = [header.map(h => wCell(h, true)), ...rows.map(row => row.map(cell => wCell(cell)))].map(cells => `<w:tr>${cells.join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${tableRows}</w:tbl>`;
}

function buildFunnelDocxXml(funnelData) {
  if (!funnelData) return '';
  const isVisibleFunnelStage = (row) => ['Meta Leads', 'Application Submitted', 'First Call Completed'].includes(row.stage);
  const isVisibleLane = ([name]) => !/test/i.test(name);
  const funnelRows = funnelData.stageRows
    .filter(isVisibleFunnelStage)
    .map(r => [r.stage, String(r.count), r.source, r.notes]);
  const openRows = topEntries(funnelData.openByStage || {}, 8)
    .filter(isVisibleLane)
    .map(([stage, count]) => [stage, String(count)]);

  return [
    wParagraph('Full Funnel — Meta → Pipedrive Swim Lanes', { bold: true, size: 28, color: '1A1A2E', spacing: 360 }),
    wParagraph('Direct Pipedrive pull from BoxDivvy Hubster Recruitment, Hub in Progress, and Hub Handovers. This shows application-stage CRM reality beside Meta attribution.', { size: 20, color: '64748B' }),
    buildTableXml(['Funnel Stage', 'Count', 'Source', 'Notes'], funnelRows),
    wParagraph(`Current open CRM funnel: ${funnelData.openTotal} deals`, { bold: true, size: 24, color: '1A1A2E', spacing: 240 }),
    buildTableXml(['Open Swim Lane', 'Open Deals'], openRows),
  ].join('');
}

function buildEcomFunnelDocxXml(ecomFunnel) {
  if (!ecomFunnel) return '';
  const w = ecomFunnel.week;
  return [
    wParagraph('Purchase Funnel — Shopping Intent → Purchase', { bold: true, size: 28, color: '1A1A2E', spacing: 360 }),
    wParagraph('Shopping intent uses the strongest pre-purchase Meta signal for the period, so the client-facing funnel stays ordered even when retargeting or return visits make checkout events higher than add-to-cart events.', { size: 20, color: '64748B' }),
    buildTableXml(
      ['Stage', 'This Week', 'Intent → Purchase'],
      [
        ['Shopping Intent', String(w.shopping_intent), w.intent_to_purchase_rate !== '—' ? w.intent_to_purchase_rate + '%' : '—'],
        ['Purchase', String(w.purchase), '—'],
      ]
    ),
  ].join('');
}

function buildWooReconciliationDocxXml(wooRecon) {
  if (!wooRecon || !wooRecon.ranges) return '';
  const weekSummary = wooRecon.ranges.week && wooRecon.ranges.week.summary || {};
  const backendRoas = weekSummary.meta_spend > 0 ? (weekSummary.revenue || 0) / weekSummary.meta_spend : 0;
  const backendCpp = weekSummary.order_count > 0 ? (weekSummary.meta_spend || 0) / weekSummary.order_count : 0;
  const salesRows = [
    ['Reconciled purchases', String(weekSummary.order_count || 0)],
    ['Reconciled revenue', formatCurrency(weekSummary.revenue || 0)],
    ['ROAS', weekSummary.meta_spend > 0 ? `${backendRoas.toFixed(2)}x` : '—']
  ];
  const metaRows = [
    ['Meta spend', formatCurrency(weekSummary.meta_spend || 0)],
    ['Reconciled purchases', String(weekSummary.order_count || 0)],
    ['Cost per purchase', weekSummary.order_count > 0 ? formatCurrency(backendCpp) : '—'],
    ['ROAS', weekSummary.meta_spend > 0 ? `${backendRoas.toFixed(2)}x` : '—']
  ];

  return [
    wParagraph('Sales Performance', { bold: true, size: 28, color: '1A1A2E', spacing: 360 }),
    wParagraph('Sales totals reconciled against WooCommerce paid kit orders.', { size: 20, color: '64748B' }),
    buildTableXml(['Sales Check', 'Value'], salesRows),
    wParagraph('Reconciled Ads Performance', { bold: true, size: 24, color: '1A1A2E', spacing: 240 }),
    buildTableXml(['Metric', 'Value'], metaRows)
  ].join('');
}

function gaMetric(row, period, metric) {
  return Number(row && row[period] && row[period][metric] || 0);
}

function gaPieRows(ga4Mix, periodKey, metric = 'revenue') {
  const rows = (ga4Mix.rows || []).map(row => ({
    channel: row.channel,
    value: gaMetric(row, periodKey, metric),
    revenue: gaMetric(row, periodKey, 'revenue'),
    transactions: gaMetric(row, periodKey, 'transactions'),
    sessions: gaMetric(row, periodKey, 'sessions')
  })).filter(row => row.value > 0);
  const sorted = rows.sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, 6);
  const other = sorted.slice(6).reduce((sum, row) => sum + row.value, 0);
  if (other > 0) top.push({ channel: 'Other', value: other, revenue: 0, transactions: 0, sessions: 0 });
  return top;
}

async function generateGa4SourceMixPieCharts(ga4Mix) {
  if (!ga4Mix || !ga4Mix.rows || !ga4Mix.rows.length) return [];
  const width = 520;
  const height = 420;
  const palette = ['#2563EB', '#16A34A', '#F97316', '#7C3AED', '#E11D48', '#0891B2', '#94A3B8'];
  const periods = [
    { key: 'current', title: 'Selected Period', range: gaRangeLabel(ga4Mix.week) },
    { key: 'previous', title: 'Previous Period', range: gaRangeLabel(ga4Mix.previous_week) },
    { key: 'month', title: 'Last 30 Days', range: gaRangeLabel(ga4Mix.last_month) }
  ];

  const charts = [];
  for (const period of periods) {
    const rows = gaPieRows(ga4Mix, period.key);
    const labels = rows.map(row => row.channel);
    const values = rows.map(row => row.value);
    const total = values.reduce((sum, value) => sum + Number(value || 0), 0);
    const chart = new ChartJSNodeCanvas({
      width,
      height,
      backgroundColour: 'white',
      chartCallback: (ChartJS) => {
        ChartJS.defaults.font.family = 'Inter, Arial, sans-serif';
        ChartJS.defaults.color = '#0F172A';
      }
    });
    const config = {
      type: 'pie',
      data: {
        labels,
        datasets: [{
          label: period.title,
          data: values,
          backgroundColor: labels.map((_, i) => palette[i % palette.length]),
          borderColor: '#FFFFFF',
          borderWidth: 2,
          hoverOffset: 4
        }]
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        layout: { padding: { top: 10, left: 12, right: 12, bottom: 8 } },
        plugins: {
          title: { display: true, text: `${period.title} GA4 Revenue Mix`, font: { size: 18, weight: 'bold' }, color: '#111827', padding: { bottom: 4 } },
          subtitle: { display: true, text: `${period.range} · ${formatCurrency(total)} total revenue`, font: { size: 11 }, color: '#64748B', padding: { bottom: 8 } },
          legend: { position: 'bottom', labels: { boxWidth: 10, padding: 8, font: { size: 10 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const value = Number(ctx.raw || 0);
                const pct = total > 0 ? (value / total * 100).toFixed(1) : '0.0';
                return `${ctx.label}: ${formatCurrency(value)} (${pct}%)`;
              }
            }
          }
        }
      }
    };
    charts.push({ ...period, buffer: await chart.renderToBuffer(config) });
  }
  return charts;
}

function addPngImageDrawingToDocx(zip, imageBuffer, imageName, widthEmu = 5486400, heightEmu = 2377440) {
  if (!imageBuffer) return '';
  const mediaPath = `word/media/${imageName}`;
  zip.file(mediaPath, imageBuffer);

  const relPath = 'word/_rels/document.xml.rels';
  let relXml = zip.file(relPath).asText();
  const existingIds = [...relXml.matchAll(/Id="rId(\d+)"/g)].map(match => Number(match[1]));
  const nextId = Math.max(0, ...existingIds) + 1;
  const relId = `rId${nextId}`;
  const rel = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${imageName}"/>`;
  relXml = relXml.replace('</Relationships>', `${rel}</Relationships>`);
  zip.file(relPath, relXml);

  const typesPath = '[Content_Types].xml';
  let typesXml = zip.file(typesPath).asText();
  if (!typesXml.includes('Extension="png"')) {
    typesXml = typesXml.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
    zip.file(typesPath, typesXml);
  }

  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${nextId}" name="${imageName}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${nextId}" name="${imageName}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function addPngImageToDocx(zip, imageBuffer, imageName, widthEmu = 5486400, heightEmu = 2377440) {
  const drawing = addPngImageDrawingToDocx(zip, imageBuffer, imageName, widthEmu, heightEmu);
  if (!drawing) return '';
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="160" w:after="220"/></w:pPr>${drawing}</w:p>`;
}

function buildThreeColumnImageTableXml(drawings) {
  if (!drawings || !drawings.length) return '';
  const cells = drawings.slice(0, 3).map(drawing => `<w:tc><w:tcPr><w:tcW w:w="3168" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${drawing}</w:p></w:tc>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="9504" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="60" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tr>${cells}</w:tr></w:tbl>`;
}


async function fetchBoxDivvyBrisbaneDrilldown(clientConfig, weekSince, weekUntil, monthSince, monthUntil, alltimeSince, alltimeUntil) {
  if (!clientConfig.name.toLowerCase().includes('box divvy')) return null;
  const filter = 'Brisbane';
  console.log('  🧭 Fetching Box Divvy Brisbane drill-down...');
  const week = await getAccountOverviewDirect(clientConfig.account_id, weekSince, weekUntil, filter);
  const month = await getAccountOverviewDirect(clientConfig.account_id, monthSince, monthUntil, filter);
  const alltime = await getAccountOverviewDirect(clientConfig.account_id, alltimeSince, alltimeUntil, filter);
  if (!week || (!week.spend && !week.conversions && !week.impressions)) {
    console.warn('  ⚠️ Brisbane drill-down skipped: no Brisbane campaign data found');
    return null;
  }
  const daily = await getDailyData(clientConfig.account_id, weekSince, weekUntil, filter);
  const topAds = await getTopAdsDirect(clientConfig.account_id, weekSince, weekUntil, 5, filter) || [];
  let chartBuffer = null;
  if (daily && daily.length) {
    chartBuffer = await generateCampaignDrilldownChart(daily, 'Brisbane Campaign Drill-down', `${weekSince} to ${weekUntil}`);
  }
  console.log(`  ✅ Brisbane drill-down: ${week.conversions || 0} leads, ${week.completed_registrations || 0} completed, ${formatCurrency(week.spend || 0)} spend`);
  return { filter, week, month, alltime, daily, topAds, chartBuffer, ranges: { week: { since: weekSince, until: weekUntil }, month: { since: monthSince, until: monthUntil }, alltime: { since: alltimeSince, until: alltimeUntil } } };
}

async function generateCampaignDrilldownChart(dailyData, title, subtitle) {
  const width = 1100;
  const height = 520;
  const chart = new ChartJSNodeCanvas({ width, height, backgroundColour: 'white' });
  const labels = dailyData.map(d => {
    const date = new Date(`${d.date}T00:00:00`);
    return date.toLocaleDateString('en-AU', { month: 'short', day: 'numeric' });
  });
  const leads = dailyData.map(d => Number(d.conversions || 0));
  const cpl = dailyData.map(d => d.cpl > 0 ? Number(d.cpl) : null);
  const spend = dailyData.map(d => Number(d.spend || 0));
  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Leads', data: leads, backgroundColor: 'rgba(16, 185, 129, 0.75)', borderColor: '#10B981', borderWidth: 1, yAxisID: 'y', order: 2 },
        { type: 'line', label: 'CPL ($)', data: cpl, borderColor: '#1E293B', backgroundColor: 'rgba(30, 41, 59, 0.08)', borderWidth: 3, pointRadius: 4, yAxisID: 'y1', tension: 0.25, order: 1 },
        { type: 'line', label: 'Spend ($)', data: spend, borderColor: '#6366F1', backgroundColor: 'rgba(99, 102, 241, 0.08)', borderWidth: 2, borderDash: [6, 5], pointRadius: 3, yAxisID: 'y1', tension: 0.25, order: 1 }
      ]
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      layout: { padding: 18 },
      plugins: {
        title: { display: true, text: title, color: '#111827', font: { size: 24, weight: 'bold' }, padding: { bottom: 2 } },
        subtitle: { display: true, text: subtitle, color: '#64748B', font: { size: 14 }, padding: { bottom: 18 } },
        legend: { position: 'bottom', labels: { color: '#475569', font: { size: 13 }, padding: 18 } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#475569', font: { size: 12 } } },
        y: { beginAtZero: true, position: 'left', title: { display: true, text: 'Leads', color: '#475569' }, ticks: { precision: 0, color: '#475569' }, grid: { color: 'rgba(148,163,184,0.22)' } },
        y1: { beginAtZero: true, position: 'right', title: { display: true, text: 'Spend / CPL ($)', color: '#475569' }, ticks: { color: '#475569' }, grid: { drawOnChartArea: false } }
      }
    }
  };
  return chart.renderToBuffer(config);
}

function drilldownMetricRows(drilldown) {
  const row = (label, ov) => ({
    period: label,
    spend: formatCurrency(ov?.spend || 0),
    leads: String(ov?.conversions || 0),
    completed: String(ov?.completed_registrations || 0),
    completionRate: formatPct(ov?.completion_rate || 0),
    cpl: formatCurrency(ov?.cost_per_conversion || 0),
    ctr: formatPct(ov?.ctr || 0)
  });
  return [row('Selected Period', drilldown.week), row('Last 30 Days', drilldown.month), row('Campaign to Date', drilldown.alltime)];
}

function buildBrisbaneDrilldownDocxXml(drilldown, chartXml = '') {
  if (!drilldown || !drilldown.week) return '';
  const summaryRows = drilldownMetricRows(drilldown);
  const summaryHeader = ['Period', 'Spend', 'Leads', 'Completed Applications', 'Completion Rate', 'CPL', 'CTR'];
  const summaryTable = [summaryHeader.map(h => wCell(h, true)), ...summaryRows.map(r => [
    wCell(r.period), wCell(r.spend), wCell(r.leads), wCell(r.completed), wCell(r.completionRate), wCell(r.cpl), wCell(r.ctr)
  ])].map(cells => `<w:tr>${cells.join('')}</w:tr>`).join('');

  const adHeader = ['Ad', 'Spend', 'Leads', 'CPL', 'CTR'];
  const adRows = (drilldown.topAds || []).slice(0, 5).map(ad => [
    wCell(ad.ad_name || 'Unnamed ad'),
    wCell(formatCurrency(ad.spend || 0)),
    wCell(String(ad.conversions || 0)),
    wCell(formatCurrency(ad.cpl || 0)),
    wCell(formatPct(ad.ctr || 0))
  ]);
  const adTable = [adHeader.map(h => wCell(h, true)), ...(adRows.length ? adRows : [[wCell('No ad-level rows returned'), wCell('—'), wCell('—'), wCell('—'), wCell('—')]])]
    .map(cells => `<w:tr>${cells.join('')}</w:tr>`).join('');

  return [
    wParagraph('Brisbane Campaign Drill-down', { bold: true, size: 28, color: '1A1A2E', spacing: 360 }),
    wParagraph('Separate view of the Brisbane campaign so it can be reviewed independently from Melbourne and Bendigo.', { size: 20, color: '64748B' }),
    chartXml,
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${summaryTable}</w:tbl>`,
    wParagraph('Top Brisbane Ads', { bold: true, size: 24, color: '1A1A2E', spacing: 260 }),
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${adTable}</w:tbl>`
  ].join('');
}

function appendBrisbaneDrilldownSection(zip, drilldown) {
  if (!drilldown) return;
  const docPath = 'word/document.xml';
  let docXml = zip.file(docPath).asText();
  const chartXml = drilldown.chartBuffer
    ? addPngImageToDocx(zip, drilldown.chartBuffer, `boxdivvy-brisbane-drilldown-${Date.now()}.png`, 5486400, 2590800)
    : '';
  const sectionXml = buildBrisbaneDrilldownDocxXml(drilldown, chartXml);
  if (!sectionXml) return;
  docXml = docXml.replace('</w:body>', `${sectionXml}</w:body>`);
  zip.file(docPath, docXml);
}

function buildGa4SourceMixDocxXml(ga4Mix, chartXml = '') {
  if (!ga4Mix || !ga4Mix.rows || !ga4Mix.rows.length) return '';
  const organic = ga4Mix.rows.find(row => row.channel === 'Organic Search');
  const paidSocial = ga4Mix.rows.find(row => row.channel === 'Paid Social');
  const contextLines = [];
  if (organic) contextLines.push(`Organic Search revenue: ${formatCurrency(organic.current.revenue || 0)} this period.`);
  if (paidSocial) contextLines.push(`GA4 Paid Social revenue: ${formatCurrency(paidSocial.current.revenue || 0)} this period.`);
  const context = contextLines.length
    ? contextLines.join(' ')
    : 'GA4 provides website channel context for the selected report period.';

  return [
    wParagraph('Website Revenue Mix', { bold: true, size: 28, color: '1A1A2E', spacing: 360 }),
    wParagraph('GA4 view of revenue by website channel for context around Meta campaign performance.', { size: 20, color: '64748B' }),
    chartXml,
    wParagraph(context, { size: 18, color: '64748B' })
  ].join('');
}

function buildDropoffDocxXml(rows, funnelData = null) {
  const header = ['Period', 'Meta Leads', 'Completed Applications', 'Dropoff', 'Completion Rate', 'Cost / Completed'];
  const tableRows = [header.map(h => wCell(h, true)), ...rows.map(r => [
    wCell(r.period),
    wCell(r.meta_leads),
    wCell(r.completed_applications),
    wCell(r.dropoff),
    wCell(r.completion_rate),
    wCell(r.cost_per_completed),
  ])].map(cells => `<w:tr>${cells.join('')}</w:tr>`).join('');

  return [
    wParagraph('Lead → Completed Application Dropoff', { bold: true, size: 28, color: '1A1A2E', spacing: 360 }),
    wParagraph('Meta lead aliases are not summed. This compares the canonical Meta Lead event against completed applications from complete_registration.', { size: 20, color: '64748B' }),
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${tableRows}</w:tbl>`,
    buildFunnelDocxXml(funnelData),
  ].join('');
}

function buildEcomDropoffDocxXml(rows, ecomFunnel = null) {
  const tableRows = (rows || []).map(r => [
    r.period,
    r.shopping_intent,
    r.purchase,
    r.intent_to_purchase_rate,
    r.atc_to_purchase_rate
  ]);
  const weekRow = (rows || []).find(r => r.period === 'This Week') || rows[0] || {};
  const shoppingIntent = Number(weekRow.shopping_intent || 0);
  const purchase = Number(weekRow.purchase || 0);
  const opportunity = shoppingIntent > 0
    ? 'Use this as the client-facing purchase-intent funnel.'
    : 'The biggest opportunity is rebuilding measurable pre-purchase intent before optimising purchase completion.';

  return [
    wParagraph('Purchase Journey', { bold: true, size: 28, color: '1A1A2E', spacing: 360 }),
    wParagraph('Client-facing funnel based on shopping intent and reconciled purchase results.', { size: 20, color: '64748B' }),
    buildTableXml(['Period', 'Shopping Intent', 'Purchase', 'Intent → Purchase', 'ATC → Purchase'], tableRows),
    wParagraph(opportunity, { size: 18, color: '64748B' })
  ].join('');
}

function appendDropoffSection(zip, rows, funnelData = null, ecomFunnel = null, wooRecon = null, ga4Mix = null) {
  const docPath = 'word/document.xml';
  const xml = zip.file(docPath).asText();
  const ga4ChartXml = ga4Mix && Array.isArray(ga4Mix.chartBuffers)
    ? buildThreeColumnImageTableXml(ga4Mix.chartBuffers.map((chart, index) => addPngImageDrawingToDocx(
        zip,
        chart.buffer,
        `ga4-source-mix-${chart.key}-${Date.now()}-${index}.png`,
        1980000,
        1600200
      )))
    : '';
  const sectionXml = ecomFunnel
    ? buildEcomDropoffDocxXml(rows, ecomFunnel) + buildWooReconciliationDocxXml(wooRecon) + buildGa4SourceMixDocxXml(ga4Mix, ga4ChartXml)
    : buildDropoffDocxXml(rows, funnelData);
  const sectPrIdx = xml.lastIndexOf('<w:sectPr');
  if (sectPrIdx === -1) {
    zip.file(docPath, xml.replace('</w:body>', `${sectionXml}</w:body>`));
    return;
  }
  zip.file(docPath, xml.slice(0, sectPrIdx) + sectionXml + xml.slice(sectPrIdx));
}

/**
 * Build latest batch table data when NO conversions exist yet.
 * Shows spend, CPM, and CTR instead of CPP/Purchases.
 * Reuses the same template field names (cpl → spend, leads → CPM) so the
 * docx template loop {#latest_batch_ads} works without changes.
 */
function buildLatestBatchMetrics(topAds, thumbnailMap = {}, adCreatedTimes = {}) {
  const rankIcons = ['🔥', '2', '⭐', '4', '5'];
  return topAds.map((ad, i) => {
    let releaseLot = guessReleaseLot(ad.ad_name);
    const createdTime = adCreatedTimes[ad.ad_id];
    if (createdTime) {
      const d = new Date(createdTime);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      releaseLot = `${months[d.getMonth()]}-${d.getDate()}`;
    }
    const cpm = ad.impressions > 0 ? (ad.spend / ad.impressions) * 1000 : 0;
    return {
      rank_icon: rankIcons[i] || String(i + 1),
      release_lot: releaseLot,
      cpl: formatCurrency(ad.spend),         // "Spend" column
      leads: cpm > 0 ? formatCurrency(cpm) : '—',  // "CPM" column
      ctr: formatPct(ad.ctr),
      ad_id: '...' + ad.ad_id.slice(-9),
      thumbnail: thumbnailMap[ad.ad_id] || PLACEHOLDER_PATH
    };
  });
}

// ─── Latest Batch Detection ────────────────────────────────────────────

/**
 * Fetch created_time for all ads in an account from the Meta Graph API.
 * Uses curl subprocess to avoid Node.js IPv6 timeout issues.
 * Returns a map of ad_id → created_time (ISO string).
 */
async function fetchAdCreatedTimes(accountId) {
  const accountIds = normalizeAccountIds(accountId);
  if (accountIds.length > 1) {
    const maps = await Promise.all(accountIds.map(id => fetchAdCreatedTimes(id)));
    return Object.assign({}, ...maps);
  }

  const singleAccountId = accountIds[0];
  const fs = require('fs');
  const { execSync } = require('child_process');

  try {
    const tokenFile = process.env.HOME + '/.secrets/meta-ads-token.txt';
    const token = fs.readFileSync(tokenFile, 'utf-8').trim();

    const adDates = {};
    let url = `https://graph.facebook.com/v22.0/${singleAccountId}/ads?` +
      `access_token=${token}&fields=id,name,created_time&limit=200`;

    while (url) {
      const rawResult = execSync(`curl -s --max-time 15 '${url}'`, { encoding: 'utf-8', timeout: 20000 });
      const result = JSON.parse(rawResult);

      if (result.error) {
        console.warn(`  ⚠️ Meta API error fetching ad dates: ${result.error.message}`);
        return adDates;
      }

      for (const ad of (result.data || [])) {
        adDates[ad.id] = ad.created_time;
      }

      url = result.paging && result.paging.next ? result.paging.next : null;
    }

    console.log(`  ✅ Fetched created_time for ${Object.keys(adDates).length} ads`);
    return adDates;
  } catch (e) {
    console.warn(`  ⚠️ Failed to fetch ad created times: ${e.message}`);
    return {};
  }
}

/**
 * Fetch insights for specific ad IDs directly from Meta Graph API.
 * Used when Pipeboard's limited response doesn't include recent batch ads.
 */
async function fetchAdInsightsDirect(adIds, since, until) {
  const fs = require('fs');
  const { execSync } = require('child_process');

  try {
    const token = fs.readFileSync(process.env.HOME + '/.secrets/meta-ads-token.txt', 'utf-8').trim();
    const timeRange = JSON.stringify({ since, until });
    const ads = [];

    // Batch in groups of 50 using the Meta batch API or sequential calls
    for (let i = 0; i < adIds.length; i += 50) {
      const batch = adIds.slice(i, i + 50);
      const idsFilter = JSON.stringify([{ field: 'ad.id', operator: 'IN', value: batch }]);
      const accountId = 'act_' + batch[0]; // We need the account ID, passed separately
      // Use ad-level insights with filtering
      for (const adId of batch) {
        try {
          const url = `https://graph.facebook.com/v22.0/${adId}/insights?access_token=${token}&fields=spend,impressions,clicks,ctr,actions,cost_per_action_type,action_values&time_range=${encodeURIComponent(timeRange)}`;
          const raw = execSync(`curl -s --max-time 10 '${url}'`, { encoding: 'utf-8', timeout: 15000 });
          const result = JSON.parse(raw);
          if (result.data && result.data[0]) {
            const row = result.data[0];
            const spend = parseFloat(row.spend || 0);
            if (spend === 0) continue;

            const { conversions, revenue, conversionType } = extractCanonicalConversionMetrics(row);
            const cpl = extractCanonicalCost(row, conversionType, spend, conversions);
            ads.push({
              ad_id: adId,
              ad_name: '', // Will be filled from adCreatedTimes context
              spend, impressions: parseInt(row.impressions || 0),
              clicks: parseInt(row.clicks || 0), ctr: parseFloat(row.ctr || 0),
              conversions, cpl, revenue, roas: revenue > 0 ? revenue / spend : 0,
              conversion_type: conversionType
            });
          }
        } catch (e) {
          // Skip individual ad errors
        }
      }
    }
    return ads;
  } catch (e) {
    console.warn(`  ⚠️ Direct ad insights fetch failed: ${e.message}`);
    return [];
  }
}

async function detectLatestBatch(allAds, limit, adCreatedTimes, accountId, since, until) {
  // If we have created_time data from Meta API, use it for accurate batch detection
  if (Object.keys(adCreatedTimes).length > 0) {
    // Group ALL ads (from Meta API) by upload date
    const adsByDate = {};
    for (const [adId, createdTime] of Object.entries(adCreatedTimes)) {
      const dateKey = createdTime.split('T')[0];
      if (!adsByDate[dateKey]) adsByDate[dateKey] = [];
      adsByDate[dateKey].push(adId);
    }

    // Sort dates descending to find the most recent batch
    const sortedDates = Object.entries(adsByDate)
      .sort((a, b) => b[0].localeCompare(a[0]));

    const [batchDate, batchAdIds] = sortedDates[0];
    console.log(`  📦 Latest batch by created_time: ${batchDate} with ${batchAdIds.length} ads`);

    // Check if we have insights data for these ads from Pipeboard
    const pipboardSet = new Set(allAds.map(a => a.ad_id));
    const batchAdsFromPipeboard = allAds.filter(a => batchAdIds.includes(a.ad_id));
    const missingIds = batchAdIds.filter(id => !pipboardSet.has(id));

    console.log(`  📦 ${batchAdsFromPipeboard.length} in Pipeboard data, ${missingIds.length} need direct fetch`);

    // Fetch missing insights directly from Meta API
    let directAds = [];
    if (missingIds.length > 0 && accountId) {
      console.log(`  📦 Fetching insights for ${missingIds.length} batch ads from Meta API...`);
      directAds = await fetchAdInsightsDirect(missingIds, since, until);
      // Fill in ad names from created_times context (we don't have names from this API)
      // We'll use the ad_id to look up names later
      console.log(`  📦 Got insights for ${directAds.length} additional ads`);
    }

    // Merge Pipeboard + direct data
    const allBatchAds = [...batchAdsFromPipeboard, ...directAds];

    // Try to get ad names for direct-fetched ads
    if (directAds.length > 0) {
      try {
        const fs = require('fs');
        const { execSync } = require('child_process');
        const token = fs.readFileSync(process.env.HOME + '/.secrets/meta-ads-token.txt', 'utf-8').trim();
        const nameIds = directAds.map(a => a.ad_id).join(',');
        const raw = execSync(`curl -s --max-time 10 'https://graph.facebook.com/v22.0/?ids=${nameIds}&access_token=${token}&fields=name'`, { encoding: 'utf-8', timeout: 15000 });
        const names = JSON.parse(raw);
        for (const ad of directAds) {
          if (names[ad.ad_id]) ad.ad_name = names[ad.ad_id].name || '';
        }
      } catch (e) {
        console.warn(`  ⚠️ Could not fetch ad names: ${e.message}`);
      }
    }

    const withConversions = allBatchAds.filter(a => a.conversions > 0);
    console.log(`  📦 ${withConversions.length} of ${allBatchAds.length} batch ads have conversions`);

    if (withConversions.length > 0) {
      return withConversions.sort((a, b) => a.cpl - b.cpl).slice(0, limit);
    }
    // No conversions yet, show top spenders
    const withSpend = allBatchAds.filter(a => a.spend > 0);
    if (withSpend.length > 0) {
      console.log(`  📦 No conversions in latest batch, showing top ${limit} spenders`);
      return withSpend.sort((a, b) => b.spend - a.spend).slice(0, limit);
    }
  }

  // Fallback: regex-based detection from ad names (Pipeboard data only)
  console.log('  📦 Falling back to ad name parsing for batch detection');
  const MONTH_MAP = {
    'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
    'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
  };

  const adsByBatch = {};
  for (const ad of allAds) {
    let batchKey = null;
    let batchDate = null;
    const dmy = ad.ad_name.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{4})/);
    if (dmy) {
      const day = parseInt(dmy[1]), month = parseInt(dmy[2]) - 1, year = parseInt(dmy[3]);
      batchDate = new Date(year, month, day);
      batchKey = `${batchDate.toISOString().split('T')[0]}`;
    } else {
      const mdd = ad.ad_name.match(/([A-Za-z]{3})[-_](\d{1,2})/);
      if (mdd) {
        const monthStr = mdd[1].toLowerCase();
        const day = parseInt(mdd[2]);
        if (MONTH_MAP[monthStr] !== undefined) {
          const year = MONTH_MAP[monthStr] >= 10 ? 2025 : 2026;
          batchDate = new Date(year, MONTH_MAP[monthStr], day);
          batchKey = `${mdd[1]}-${mdd[2]}`;
        }
      }
    }

    if (batchKey && batchDate) {
      if (!adsByBatch[batchKey]) adsByBatch[batchKey] = { date: batchDate, ads: [] };
      adsByBatch[batchKey].ads.push(ad);
    }
  }

  const sortedBatches = Object.entries(adsByBatch)
    .sort((a, b) => b[1].date - a[1].date);

  if (sortedBatches.length > 0) {
    const [batchName, batchData] = sortedBatches[0];
    console.log(`  📦 Detected latest batch by name: "${batchName}" with ${batchData.ads.length} ads`);
    const withConversions = batchData.ads.filter(a => a.conversions > 0);
    if (withConversions.length > 0) {
      return withConversions.sort((a, b) => a.cpl - b.cpl).slice(0, limit);
    }
    return batchData.ads.sort((a, b) => b.spend - a.spend).slice(0, limit);
  }

  console.log('  📦 No batch pattern found, using top ads by recency');
  return allAds.slice(0, limit);
}

// ─── DOCX Generation ──────────────────────────────────────────────────

async function generateReport(clientConfig, since, until) {
  const accountIds = normalizeAccountIds(clientConfig);
  const reportAccountId = accountIds.length > 1
    ? {
        account_ids: accountIds,
        report_currency: clientConfig.report_currency || 'AUD',
        account_currency: clientConfig.account_currency || {},
        currency_rates_to_report: clientConfig.currency_rates_to_report || {},
      }
    : accountIds[0];
  const accountLabel = accountIds.join(', ');
  const currencyLabel = clientConfig.report_currency || 'AUD';

  console.log(`\n🔄 Generating report for ${clientConfig.name}`);
  console.log(`   Period: ${since} to ${until}`);
  console.log(`   Account: ${accountLabel}`);
  if (accountIds.length > 1) {
    for (const id of accountIds) {
      const fx = currencyMultiplierForAccount(id, reportAccountId);
      console.log(`   Currency: ${id} ${fx.sourceCurrency} → ${fx.targetCurrency} ×${fx.multiplier}`);
    }
  }
  console.log('');

  // ── Compute date ranges for 3 metric sections
  const weekSince = since;
  const weekUntil = until;

  // Month: 30 days back from until
  const untilDate = new Date(until);
  const monthStart = new Date(untilDate);
  monthStart.setDate(monthStart.getDate() - 29);
  const monthSince = monthStart.toISOString().split('T')[0];
  const monthUntil = until;

  // All-time: use client's start date from database
  const clientStartDate = getClientStartDate(clientConfig.name);
  console.log(`  📅 Client start date: ${clientStartDate}`);
  const alltimeSince = clientStartDate;
  const alltimeUntil = until;

  // ── Fetch all data
  console.log('📊 Fetching data from Pipeboard...');

  // Use only explicit campaign_filter to scope data. campaign_name is display copy;
  // e-commerce accounts can span multiple funnel campaigns after restructuring.
  const campaignFilter = clientConfig.campaign_filter || null;

  // Helper: try Pipeboard first, fall back to direct Meta API if empty/failed
  async function fetchOverview(label, accountId, since, until, filter) {
    console.log(`\n  📅 ${label} period: ${since} to ${until}`);
    let ov = await getAccountOverview(accountId, since, until, filter);
    if (!ov.spend && ov.spend !== 0 || (ov.spend === 0 && ov.conversions === 0 && ov.impressions === 0)) {
      console.log(`  ⚠️ Pipeboard returned empty for ${label}, trying direct Meta API...`);
      ov = await getAccountOverviewDirect(accountId, since, until, filter);
    }
    console.log(`  ✅ ${label} overview:`, JSON.stringify({
      spend: ov.spend, leads: ov.conversions, completed: ov.completed_registrations, completion_rate: ov.completion_rate, cpl: ov.cost_per_conversion, ctr: ov.ctr, type: ov.conversion_type
    }));
    return ov;
  }

  const overview = await fetchOverview('Week', reportAccountId, weekSince, weekUntil, campaignFilter);
  const monthOverview = await fetchOverview('Month', reportAccountId, monthSince, monthUntil, campaignFilter);
  const alltimeOverview = await fetchOverview('All-time', reportAccountId, alltimeSince, alltimeUntil, campaignFilter);
  // ── Build funnel data: Pipedrive CRM funnel for BoxDivvy, ecom funnel for purchase-based clients
  let pipedriveFunnel = null;
  let ecomFunnel = null;
  let wooRecon = null;
  let ga4Mix = null;
  let brisbaneDrilldown = null;
  const isEcommerce = overview.conversion_type === 'purchase';

  if (clientConfig.name.toLowerCase().includes('box divvy')) {
    pipedriveFunnel = await fetchBoxDivvyPipedriveFunnel(weekSince, weekUntil, overview);
    if (pipedriveFunnel) {
      console.log(`  ✅ Pipedrive funnel: ${pipedriveFunnel.createdTotal} CRM deals created, ${pipedriveFunnel.openTotal} open, ${pipedriveFunnel.lostTotal} lost this period`);
    }
    brisbaneDrilldown = await fetchBoxDivvyBrisbaneDrilldown(clientConfig, weekSince, weekUntil, monthSince, monthUntil, alltimeSince, alltimeUntil);
  } else if (isEcommerce) {
    // E-commerce funnel: ATC → Checkout → Purchase from Meta action totals
    function buildEcomFunnel(ov, label) {
      const atc = ov.atc_count || 0;
      const checkout = ov.checkout_count || 0;
      const purchase = ov.purchase_count || 0;
      const shoppingIntent = Math.max(atc, checkout);
      return {
        atc, checkout, shopping_intent: shoppingIntent, purchase,
        intent_to_purchase_rate: shoppingIntent > 0 ? (purchase / shoppingIntent * 100).toFixed(1) : '—',
        atc_to_purchase_rate: atc > 0 ? (purchase / atc * 100).toFixed(1) : '—',
        label
      };
    }
    const weekFunnel = buildEcomFunnel(overview, 'This Week');
    const monthFunnel = buildEcomFunnel(monthOverview, 'Last 30 Days');
    const alltimeFunnel = buildEcomFunnel(alltimeOverview, 'Campaign to Date');
    ecomFunnel = { week: weekFunnel, month: monthFunnel, alltime: alltimeFunnel };

    // Chart-compatible funnel data (uses week data for the visual)
    ecomFunnel.chart = {
      title: 'Purchase Funnel: Shopping Intent → Purchase',
      subtitle: `${weekSince} to ${weekUntil} · Meta attributed events`,
      stages: [
        { label: 'Shopping Intent', value: weekFunnel.shopping_intent || 0 },
        { label: 'Purchase', value: overview.purchase_count || 0 },
      ],
      notes: [
        `Intent → Purchase: ${weekFunnel.intent_to_purchase_rate}%`,
        `Raw ATC: ${overview.atc_count || 0} · Raw Checkout: ${overview.checkout_count || 0}`,
      ],
      lossSummary: []
    };
    console.log(`  ✅ E-com funnel: ShoppingIntent=${weekFunnel.shopping_intent}, Purchase=${overview.purchase_count} (raw ATC=${overview.atc_count}, Checkout=${overview.checkout_count})`);
  }

  wooRecon = await fetchWooReconciliation(clientConfig, {
    week: { since: weekSince, until: weekUntil },
    month: { since: monthSince, until: monthUntil },
    alltime: { since: alltimeSince, until: alltimeUntil }
  }, {
    week: overview,
    month: monthOverview,
    alltime: alltimeOverview
  });

  if (isEcommerce && wooRecon) {
    const publicFunnels = buildReconciledEcomOverviews(overview, monthOverview, alltimeOverview, wooRecon);
    const buildPublicEcomFunnel = (ov, label) => {
      const atc = ov.atc_count || 0;
      const checkout = ov.checkout_count || 0;
      const purchase = ov.purchase_count || ov.conversions || 0;
      const shoppingIntent = Math.max(atc, checkout);
      return {
        atc, checkout, shopping_intent: shoppingIntent, purchase,
        intent_to_purchase_rate: shoppingIntent > 0 ? (purchase / shoppingIntent * 100).toFixed(1) : '—',
        atc_to_purchase_rate: atc > 0 ? (purchase / atc * 100).toFixed(1) : '—',
        label
      };
    };
    const weekFunnel = buildPublicEcomFunnel(publicFunnels.week, 'This Week');
    ecomFunnel = {
      week: weekFunnel,
      month: buildPublicEcomFunnel(publicFunnels.month, 'Last 30 Days'),
      alltime: buildPublicEcomFunnel(publicFunnels.alltime, 'Campaign to Date'),
      chart: {
        title: 'Purchase Funnel: Shopping Intent → Purchase',
        subtitle: `${weekSince} to ${weekUntil} · reconciled purchase results`,
        stages: [
          { label: 'Shopping Intent', value: weekFunnel.shopping_intent || 0 },
          { label: 'Purchase', value: weekFunnel.purchase || 0 },
        ],
        notes: [
          `Intent → Purchase: ${weekFunnel.intent_to_purchase_rate}%`,
          `Raw ATC: ${overview.atc_count || 0} · Raw Checkout: ${overview.checkout_count || 0}`,
        ],
        lossSummary: []
      }
    };
  }

  ga4Mix = await fetchGa4SourceMix(clientConfig, {
    week: { since: weekSince, until: weekUntil },
    month: { since: monthSince, until: monthUntil }
  });
  if (ga4Mix) {
    try {
      ga4Mix.chartBuffers = await generateGa4SourceMixPieCharts(ga4Mix);
      const bytes = ga4Mix.chartBuffers.reduce((sum, chart) => sum + (chart.buffer?.length || 0), 0);
      if (ga4Mix.chartBuffers.length) console.log(`  ✅ GA4 separate pie graphs generated (${ga4Mix.chartBuffers.length} charts, ${bytes} bytes)`);
    } catch (e) {
      console.warn(`  ⚠️ GA4 pie graph generation failed: ${e.message}`);
    }
  }

  // Try Meta API directly first (accurate, no row limit), fall back to Pipeboard
  let topAds = await getTopAdsDirect(reportAccountId, alltimeSince, alltimeUntil, 5, campaignFilter);
  if (!topAds) {
    console.log('  Falling back to Pipeboard for top ads...');
    topAds = await getTopAds(reportAccountId, alltimeSince, alltimeUntil, 5, campaignFilter);
  }
  console.log(`  ✅ Top ${topAds.length} ads fetched (all-time period: ${alltimeSince} to ${alltimeUntil})`);

  const demographics = await getDemographics(reportAccountId, since, until);
  console.log(`  ✅ ${demographics.length} demographic rows`);

  // ── Fetch ALL ads for latest batch detection (not just those with conversions)
  console.log('\n  🔍 Detecting latest batch for top performers...');
  const allAdsForBatch = await getAllAds(reportAccountId, alltimeSince, alltimeUntil, campaignFilter);
  console.log(`  Found ${allAdsForBatch.length} total ads for batch detection`);

  // Fetch actual created_time from Meta API for accurate batch detection
  console.log('  📅 Fetching ad upload dates from Meta API...');
  const adCreatedTimes = await fetchAdCreatedTimes(reportAccountId);

  const latestBatchAds = await detectLatestBatch(allAdsForBatch, 5, adCreatedTimes, reportAccountId, alltimeSince, alltimeUntil);
  console.log(`  ✅ Latest batch: ${latestBatchAds.length} ads`);

  // ── Generate 3-panel stacked chart (weekly data)
  let chartBuffer = null;
  let weeklyData = [];
  try {
    weeklyData = await fetchWeeklyData(reportAccountId, since, until, 8, campaignFilter);
    if (isEcommerce) {
      weeklyData = await reconcileWeeklyChartDataWithWoo(clientConfig, weeklyData);
      const currentChartWeek = weeklyData[weeklyData.length - 1] || {};
      console.log(`  ✅ Reconciled chart current week: purchases=${currentChartWeek.conversions || 0}, CPP=${formatCurrency(currentChartWeek.cpl || 0)}, ROAS=${(currentChartWeek.roas || 0).toFixed(2)}x`);
    }
    console.log(`  ✅ ${weeklyData.length} weeks of data for chart`);
    if (weeklyData.length > 0) {
      chartBuffer = await generateStackedChart(weeklyData, clientConfig.name, since, until, pipedriveFunnel ? pipedriveFunnel.chart : (ecomFunnel ? ecomFunnel.chart : null));
      console.log(`  ✅ 4-panel chart generated (${chartBuffer.length} bytes)`);
      // Also save chart as standalone PNG
      const chartPath = path.join(REPORTS_DIR, `${clientConfig.name.replace(/[^a-zA-Z0-9]/g, '')}_chart_${new Date().toISOString().split('T')[0]}.png`);
      fs.writeFileSync(chartPath, chartBuffer);
      console.log(`  ✅ Chart saved: ${chartPath}`);
    }
  } catch (e) {
    console.warn('  ⚠️ Chart generation failed, continuing without:', e.message);
  }

  // ── Fetch thumbnails for all unique ads
  const allUniqueAdIds = [...new Set([
    ...topAds.map(a => a.ad_id),
    ...latestBatchAds.map(a => a.ad_id)
  ])].filter(Boolean);
  const thumbnailMap = await fetchAdThumbnails(allUniqueAdIds);

  // ── Build template data
  const period = formatDateRange(since, until);
  const topAdsData = buildTopAdsData(topAds, thumbnailMap, adCreatedTimes);
  const demoInsights = buildDemographicInsights(demographics);
  const reconciledEcom = isEcommerce
    ? buildReconciledEcomOverviews(overview, monthOverview, alltimeOverview, wooRecon)
    : { week: overview, month: monthOverview, alltime: alltimeOverview };
  const publicWeekOverview = reconciledEcom.week;
  const publicMonthOverview = reconciledEcom.month;
  const publicAlltimeOverview = reconciledEcom.alltime;
  const dropoffRows = isEcommerce
    ? buildEcomDropoffRows(publicWeekOverview, publicMonthOverview, publicAlltimeOverview)
    : buildDropoffRows(overview, monthOverview, alltimeOverview);

  // Build release lot performance from top ads
  const lotGroups = {};
  for (const ad of topAds) {
    const lot = guessReleaseLot(ad.ad_name);
    if (!lotGroups[lot]) lotGroups[lot] = { conversions: 0, spend: 0, count: 0, bestCost: Infinity };
    lotGroups[lot].conversions += ad.conversions;
    lotGroups[lot].spend += ad.spend;
    lotGroups[lot].count += 1;
    lotGroups[lot].bestCost = Math.min(lotGroups[lot].bestCost, ad.cpl);
  }

  const releaseLots = Object.entries(lotGroups).map(([lot, data]) => ({
    title: `${lot} Release`,
    description: `${data.conversions} conversions from ${data.count} ad(s) – Best cost: ${formatCurrency(data.bestCost)}`
  }));

  // Creative insights from top 2 ads
  const creativeInsights = topAds.slice(0, 2).map((ad, i) => ({
    title: i === 0 ? 'Top Performer:' : 'Runner Up:',
    description: `${ad.ad_name} – ${ad.conversions} conversions at ${formatCurrency(ad.cpl)} cost, ${formatPct(ad.ctr)} CTR`
  }));

  const tableFootnote = topAds.length > 0
    ? `🔥 = Top performer | ⭐ = Volume star | Sorted by cost per conversion (lowest first)`
    : 'Data from the reporting period';

  // ── Determine if e-commerce (purchase conversions) or lead gen (set earlier for funnel building)
  console.log(`  ${isEcommerce ? '🛒 E-commerce mode (purchases/ROAS)' : '📋 Lead gen mode (leads/CPL)'}`);

  // ── Build latest batch data — switch columns based on whether any ads have conversions
  const latestBatchHasConversions = latestBatchAds.some(a => a.conversions > 0);
  let latestBatchData, latestBatchHeading, latestBatchCol3, latestBatchCol4;

  if (latestBatchHasConversions) {
    // Normal mode: show cost per conversion and conversion count
    latestBatchData = buildTopAdsData(latestBatchAds, thumbnailMap, adCreatedTimes);
    latestBatchHeading = 'Latest Batch — Top Performers';
    latestBatchCol3 = isEcommerce ? 'CPP' : 'CPL';
    latestBatchCol4 = isEcommerce ? 'Purchases' : 'Leads';
  } else {
    // No conversions yet: show Spend, CPM, CTR as "Top Metrics"
    latestBatchHeading = 'Latest Batch — Top Metrics';
    latestBatchCol3 = 'Spend';
    latestBatchCol4 = 'CPM';
    latestBatchData = buildLatestBatchMetrics(latestBatchAds, thumbnailMap, adCreatedTimes);
  }
  // Generate AI-powered insights
  console.log('  🤖 Generating AI-powered insights...');
  const aiInsights = await generateAIInsights(publicWeekOverview, topAds, isEcommerce, clientConfig.name);

  const whatsWorking = aiInsights.whatsWorking.map(text => ({ text }));
  const opportunities = aiInsights.opportunities.map(text => ({ text }));
  const nextSteps = aiInsights.nextSteps.map(text => ({ text }));

  // Generate executive summary with correct conversion type
  const execSummary = generateExecutiveSummary(overview, topAds, clientConfig.name, isEcommerce, wooRecon);

  // ── Template data object
  const data = {
    client_name: clientConfig.name,
    campaign_name: clientConfig.campaign_name || 'All Campaigns',
    period,
    executive_summary: execSummary,

    // Week metrics
    week_spend: formatCurrency(overview.spend || 0),
    week_leads: String(publicWeekOverview.conversions || 0),
    week_completed_applications: String(publicWeekOverview.completed_registrations || 0),
    week_completion_rate: formatPct(publicWeekOverview.completion_rate || 0),
    week_dropoff: String(publicWeekOverview.dropoff_count || 0),
    week_cpl: formatCurrency(publicWeekOverview.cost_per_conversion || 0),
    week_ctr: formatPct(publicWeekOverview.ctr || 0),

    // Month metrics
    month_spend: formatCurrency(monthOverview.spend || 0),
    month_leads: String(publicMonthOverview.conversions || 0),
    month_cpl: formatCurrency(publicMonthOverview.cost_per_conversion || 0),
    month_ctr: formatPct(publicMonthOverview.ctr || 0),

    // All-time metrics (since campaign start)
    alltime_spend: formatCurrency(alltimeOverview.spend || 0),
    alltime_leads: String(publicAlltimeOverview.conversions || 0),
    alltime_cpl: formatCurrency(publicAlltimeOverview.cost_per_conversion || 0),
    alltime_ctr: formatPct(publicAlltimeOverview.ctr || 0),

    // E-commerce metrics (ROAS & Revenue)
    week_roas: publicWeekOverview.roas > 0 ? publicWeekOverview.roas.toFixed(2) + 'x' : 'N/A',
    month_roas: publicMonthOverview.roas > 0 ? publicMonthOverview.roas.toFixed(2) + 'x' : 'N/A',
    alltime_roas: publicAlltimeOverview.roas > 0 ? publicAlltimeOverview.roas.toFixed(2) + 'x' : 'N/A',
    week_revenue: formatCurrency(publicWeekOverview.revenue || 0),
    month_revenue: formatCurrency(publicMonthOverview.revenue || 0),
    alltime_revenue: formatCurrency(publicAlltimeOverview.revenue || 0),

    // WooCommerce backend sales reconciliation (NeedleFree only; unused by lead-gen templates)
    week_backend_orders: String(wooRecon?.ranges?.week?.summary?.order_count || 0),
    week_backend_revenue: formatCurrency(wooRecon?.ranges?.week?.summary?.revenue || 0),
    week_backend_cpp: wooRecon?.ranges?.week?.summary?.order_count ? formatCurrency(wooRecon.ranges.week.summary.backend_cpp || 0) : '—',
    week_backend_roas: wooRecon?.ranges?.week?.summary?.meta_spend ? `${(wooRecon.ranges.week.summary.backend_roas || 0).toFixed(2)}x` : '—',
    week_meta_capture: wooRecon?.ranges?.week?.summary?.order_count ? formatPct(wooRecon.ranges.week.summary.purchase_capture_rate || 0) : '—',
    month_backend_orders: String(wooRecon?.ranges?.month?.summary?.order_count || 0),
    month_backend_revenue: formatCurrency(wooRecon?.ranges?.month?.summary?.revenue || 0),
    alltime_backend_orders: String(wooRecon?.ranges?.alltime?.summary?.order_count || 0),
    alltime_backend_revenue: formatCurrency(wooRecon?.ranges?.alltime?.summary?.revenue || 0),

    // Ad tables
    latest_batch_heading: latestBatchHeading,
    latest_batch_col3: latestBatchCol3,
    latest_batch_col4: latestBatchCol4,
    latest_batch_ads: latestBatchData,
    top_ads: topAdsData,
    table_footnote: tableFootnote,

    release_lots: releaseLots.length > 0 ? releaseLots : [{ title: 'All', description: 'Performance data aggregated across all release lots' }],
    creative_insights: creativeInsights.length > 0 ? creativeInsights : [{ title: 'Analysis pending', description: 'More data needed for creative insights' }],
    demographics: demoInsights,
    dropoff_rows: dropoffRows,
    whats_working: whatsWorking,
    opportunities,
    next_steps: nextSteps
  };

  // ── Fill template
  console.log('\n📝 Filling template...');
  const templatePath = isEcommerce ? TEMPLATE_ECOM_PATH : TEMPLATE_PATH;
  console.log(`  Using ${isEcommerce ? 'e-commerce' : 'lead gen'} template: ${path.basename(templatePath)}`);
  const templateContent = fs.readFileSync(templatePath);
  const zip = new PizZip(templateContent);

  // Image module for chart + thumbnails
  const imageOpts = {
    centered: false,
    getImage: (tagValue) => {
      if (tagValue === 'chart' && chartBuffer) return chartBuffer;
      // Thumbnail file paths (absolute paths to local files)
      if (tagValue && typeof tagValue === 'string' && fs.existsSync(tagValue)) {
        return fs.readFileSync(tagValue);
      }
      // Fallback: 1px transparent PNG
      return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    },
    getSize: (img, tagValue) => {
      if (tagValue === 'chart') return [580, 720];  // 4-panel stacked chart, scaled to fit page width
      // Thumbnails: small 50x50 preview
      if (tagValue && typeof tagValue === 'string' && (tagValue.includes('thumbnails/') || tagValue.includes('thumbnails\\'))) {
        return [50, 50];
      }
      return [1, 1];
    }
  };

  const doc = new Docxtemplater(zip, {
    modules: [new ImageModule(imageOpts)],
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{', end: '}' }
  });

  // Set data
  doc.setData({ ...data, chart_image: 'chart' });
  doc.render();
  appendDropoffSection(zip, dropoffRows, pipedriveFunnel, ecomFunnel, wooRecon, ga4Mix);
  appendBrisbaneDrilldownSection(zip, brisbaneDrilldown);

  // ── Save
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const clientSlug = clientConfig.name.replace(/[^a-zA-Z0-9]/g, '');
  const today = new Date().toISOString().split('T')[0];
  const outputFilename = `${clientSlug}_${today}.docx`;
  const outputPath = path.join(REPORTS_DIR, outputFilename);

  const output = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outputPath, output);

  console.log(`\n✅ Report generated: ${outputPath}`);
  console.log(`   Size: ${(output.length / 1024).toFixed(1)} KB`);
  return outputPath;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function formatDateRange(since, until) {
  const s = new Date(since);
  const u = new Date(until);
  const opts = { day: 'numeric', month: 'long', year: 'numeric' };
  return `${s.toLocaleDateString('en-AU', opts)} – ${u.toLocaleDateString('en-AU', opts)}`;
}

function computeDateRange(preset = 'last_7d') {
  const today = new Date();
  let end = new Date(today);
  end.setDate(end.getDate() - 1);
  let start = new Date(end);

  switch (preset) {
    case 'last_7d': start.setDate(start.getDate() - 6); break;
    case 'last_14d': start.setDate(start.getDate() - 13); break;
    case 'last_30d': start.setDate(start.getDate() - 29); break;
    default: start.setDate(start.getDate() - 6);
  }

  return {
    since: start.toISOString().split('T')[0],
    until: end.toISOString().split('T')[0]
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const config = loadConfig();

  // Parse args
  let clientName = null;
  let since = null;
  let until = null;
  let preset = 'last_7d';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--client') {
      clientName = args[++i];
    } else if (args[i] === '--since') {
      since = args[++i];
    } else if (args[i] === '--until') {
      until = args[++i];
    } else if (args[i] === '--preset') {
      preset = args[++i];
    } else if (!args[i].startsWith('--') && clientName === null) {
      // Positional argument: client name
      clientName = args[i];
    }
  }

  // Default to first client if not specified
  if (!clientName) {
    clientName = config.clients[0].name;
  }

  // Find client config
  const clientConfig = config.clients.find(c => 
    c.name.toLowerCase().includes(clientName.toLowerCase())
  );
  if (!clientConfig) {
    console.error(`Client "${clientName}" not found in config. Available: ${config.clients.map(c => c.name).join(', ')}`);
    process.exit(1);
  }

  await refreshClientCurrencyRates(config, clientConfig);

  // Date range
  if (!since || !until) {
    const range = computeDateRange(preset);
    since = since || range.since;
    until = until || range.until;
  }

  try {
    const outputPath = await generateReport(clientConfig, since, until);
    // Print path for programmatic use
    console.log(`\nOUTPUT_PATH=${outputPath}`);

    // Auto-register in report viewer: convert DOCX → HTML via mammoth + register in state.db
    try {
      const mammoth = require('mammoth');
      const { execSync } = require('child_process');
      
      const result = await mammoth.convertToHtml({path: outputPath}, {
        convertImage: mammoth.images.imgElement(function(image) {
          return image.read('base64').then(function(buf) {
            return { src: 'data:' + image.contentType + ';base64,' + buf };
          });
        })
      });
      
      const html = `<!DOCTYPE html><html><head><style>
        body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #333; line-height: 1.6; }
        h1 { color: #1a1a2e; border-bottom: 3px solid #e94560; padding-bottom: 10px; }
        h2 { color: #1a1a2e; margin-top: 30px; }
        table { border-collapse: collapse; width: 100%; margin: 20px 0; }
        th, td { border: 1px solid #ddd; padding: 10px 14px; text-align: left; }
        th { background: #1a1a2e; color: white; font-weight: 600; }
        tr:nth-child(even) { background: #f8f9fa; }
        img { max-width: 100%; height: auto; margin: 20px 0; border-radius: 8px; }
        ul { padding-left: 20px; } li { margin-bottom: 6px; } p { margin: 10px 0; }
      </style></head><body>${result.value}</body></html>`;
      
      const stagingDir = '/tmp/client-reports-staging';
      fs.mkdirSync(stagingDir, { recursive: true });
      const htmlFilename = path.basename(outputPath, '.docx') + '.html';
      const htmlPath = path.join(stagingDir, htmlFilename);
      fs.writeFileSync(htmlPath, html);
      
      // Register in SQLite. Prefer sqlite3 CLI when present, fall back to Python sqlite3
      // because Poseidon report boxes do not always have the sqlite3 binary installed.
      const DB_PATH = path.join(__dirname, 'state.db');
      const { spawnSync } = require('child_process');
      const registerEnv = {
        ...process.env,
        REPORT_DB_PATH: DB_PATH,
        REPORT_CLIENT_NAME: clientConfig.name,
        REPORT_SINCE: since,
        REPORT_UNTIL: until,
        REPORT_HTML_PATH: htmlPath,
        REPORT_DOCX_PATH: outputPath
      };
      const pyRegister = spawnSync('python3', ['-c', `
import os, sqlite3
conn = sqlite3.connect(os.environ['REPORT_DB_PATH'])
cur = conn.cursor()
client_name = os.environ['REPORT_CLIENT_NAME']
row = cur.execute("SELECT id FROM clients WHERE name LIKE ?", (f"%{client_name}%",)).fetchone()
client_id = row[0] if row else 1
cur.execute("""
INSERT INTO reports (client_id, start_date, end_date, status, html_path, docx_path, completed_at)
VALUES (?, ?, ?, 'ready', ?, ?, datetime('now'))
""", (
  client_id,
  os.environ['REPORT_SINCE'],
  os.environ['REPORT_UNTIL'],
  os.environ['REPORT_HTML_PATH'],
  os.environ['REPORT_DOCX_PATH']
))
conn.commit()
print(client_id)
`], { encoding: 'utf-8', env: registerEnv });
      if (pyRegister.status !== 0) {
        throw new Error((pyRegister.stderr || pyRegister.stdout || 'Python sqlite registration failed').trim());
      }
      
      console.log(`✅ Registered in report viewer: ${htmlPath}`);
    } catch (viewerErr) {
      console.warn(`⚠️ Report viewer registration failed (non-fatal): ${viewerErr.message}`);
    }
  } catch (err) {
    console.error('❌ Report generation failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
