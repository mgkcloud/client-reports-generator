function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toInt(value) {
  const n = parseInt(value || 0, 10);
  return Number.isFinite(n) ? n : 0;
}

function normalizeAccountIds(input) {
  const source = Array.isArray(input?.account_ids) && input.account_ids.length
    ? input.account_ids
    : input?.account_id ?? input;
  const raw = Array.isArray(source) ? source : String(source || '').split(',');
  return [...new Set(raw.map(v => String(v).trim()).filter(Boolean))];
}

function detectConversionType(rows) {
  return rows.some(r => r?.conversion_type === 'purchase' || toInt(r?.purchase_count) > 0 || toNumber(r?.revenue) > 0)
    ? 'purchase'
    : 'lead';
}

function normalizeCurrencyCode(value) {
  return String(value || 'AUD').trim().toUpperCase();
}

function currencyMultiplierForAccount(accountId, context = {}) {
  const targetCurrency = normalizeCurrencyCode(context.report_currency || 'AUD');
  const accountCurrency = context.account_currency || {};
  const sourceCurrency = normalizeCurrencyCode(accountCurrency[accountId] || targetCurrency);
  const rates = context.currency_rates_to_report || {};
  const multiplier = sourceCurrency === targetCurrency ? 1 : toNumber(rates[sourceCurrency]);
  return {
    sourceCurrency,
    targetCurrency,
    multiplier: multiplier > 0 ? multiplier : 1,
  };
}

function getSourceCurrencies(context = {}) {
  const targetCurrency = normalizeCurrencyCode(context.report_currency || 'AUD');
  const accountCurrency = context.account_currency || {};
  return [...new Set(Object.values(accountCurrency).map(normalizeCurrencyCode).filter(Boolean))]
    .filter(currency => currency !== targetCurrency);
}

async function fetchExchangeRateToReport(sourceCurrency, targetCurrency) {
  const source = normalizeCurrencyCode(sourceCurrency);
  const target = normalizeCurrencyCode(targetCurrency);
  if (source === target) return 1;
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable; cannot refresh exchange rates');
  }
  const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(source)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`FX request failed for ${source}→${target}: HTTP ${response.status}`);
  const body = await response.json();
  const rate = toNumber(body?.rates?.[target]);
  if (rate <= 0) throw new Error(`FX response missing ${source}→${target} rate`);
  return rate;
}

async function refreshCurrencyRatesToReport(context = {}, fetchRate = fetchExchangeRateToReport) {
  const targetCurrency = normalizeCurrencyCode(context.report_currency || 'AUD');
  const refreshedRates = { ...(context.currency_rates_to_report || {}), [targetCurrency]: 1 };
  for (const sourceCurrency of getSourceCurrencies(context)) {
    refreshedRates[sourceCurrency] = await fetchRate(sourceCurrency, targetCurrency);
  }
  return {
    ...context,
    report_currency: targetCurrency,
    currency_rates_to_report: refreshedRates,
    currency_rates_updated_at: new Date().toISOString(),
    currency_rate_source: 'open.er-api.com',
  };
}

const MONEY_FIELDS = [
  'spend',
  'revenue',
  'cpm',
  'cpc',
  'cpl',
  'cpp',
  'cost_per_conversion',
  'cost_per_completed_registration',
];

function convertActionValueArray(items, multiplier) {
  if (!Array.isArray(items)) return items;
  return items.map(item => ({
    ...item,
    value: String(toNumber(item.value) * multiplier),
  }));
}

function normalizeCurrencyRow(row, accountId, context = {}) {
  if (!row) return row;
  const { sourceCurrency, targetCurrency, multiplier } = currencyMultiplierForAccount(accountId || row.account_id, context);
  const normalized = { ...row };
  for (const field of MONEY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(normalized, field)) {
      normalized[field] = toNumber(normalized[field]) * multiplier;
    }
  }
  normalized.cost_per_action_type = convertActionValueArray(normalized.cost_per_action_type, multiplier);
  normalized.action_values = convertActionValueArray(normalized.action_values, multiplier);
  normalized.source_currency = sourceCurrency;
  normalized.report_currency = targetCurrency;
  normalized.currency_multiplier = multiplier;
  return normalized;
}

function normalizeCurrencyRows(rows, accountId, context = {}) {
  return (rows || []).map(row => normalizeCurrencyRow(row, accountId || row?.account_id, context));
}

function mergeOverviewRows(rows) {
  const valid = rows.filter(Boolean);
  const merged = {
    account_ids: [...new Set(valid.flatMap(r => normalizeAccountIds(r.account_ids || r.account_id)))],
    spend: valid.reduce((sum, r) => sum + toNumber(r.spend), 0),
    impressions: valid.reduce((sum, r) => sum + toInt(r.impressions), 0),
    reach: valid.reduce((sum, r) => sum + toInt(r.reach), 0),
    clicks: valid.reduce((sum, r) => sum + toInt(r.clicks), 0),
    conversions: valid.reduce((sum, r) => sum + toInt(r.conversions), 0),
    completed_registrations: valid.reduce((sum, r) => sum + toInt(r.completed_registrations), 0),
    dropoff_count: valid.reduce((sum, r) => sum + toInt(r.dropoff_count), 0),
    revenue: valid.reduce((sum, r) => sum + toNumber(r.revenue), 0),
    atc_count: valid.reduce((sum, r) => sum + toInt(r.atc_count), 0),
    checkout_count: valid.reduce((sum, r) => sum + toInt(r.checkout_count), 0),
    purchase_count: valid.reduce((sum, r) => sum + toInt(r.purchase_count), 0),
    actions: valid.flatMap(r => Array.isArray(r.actions) ? r.actions : []),
    cost_per_action_type: valid.flatMap(r => Array.isArray(r.cost_per_action_type) ? r.cost_per_action_type : []),
    action_values: valid.flatMap(r => Array.isArray(r.action_values) ? r.action_values : []),
  };
  merged.conversion_type = detectConversionType(valid);
  merged.cpm = merged.impressions > 0 ? merged.spend / merged.impressions * 1000 : 0;
  merged.cpc = merged.clicks > 0 ? merged.spend / merged.clicks : 0;
  merged.ctr = merged.impressions > 0 ? merged.clicks / merged.impressions * 100 : 0;
  merged.cost_per_conversion = merged.conversions > 0 ? merged.spend / merged.conversions : 0;
  merged.cost_per_completed_registration = merged.completed_registrations > 0 ? merged.spend / merged.completed_registrations : 0;
  merged.completion_rate = merged.conversions > 0 ? merged.completed_registrations / merged.conversions * 100 : 0;
  merged.dropoff_rate = merged.conversions > 0 ? merged.dropoff_count / merged.conversions * 100 : 0;
  merged.roas = merged.revenue > 0 && merged.spend > 0 ? merged.revenue / merged.spend : 0;
  return merged;
}

function mergeBreakdownRows(rows, keyFields) {
  const byKey = new Map();
  for (const row of rows.filter(Boolean)) {
    const key = keyFields.map(field => row[field] || 'unknown').join('::');
    if (!byKey.has(key)) {
      const base = {};
      for (const field of keyFields) base[field] = row[field] || 'unknown';
      byKey.set(key, { ...base, spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, conversion_type: row.conversion_type || 'lead' });
    }
    const current = byKey.get(key);
    current.spend += toNumber(row.spend);
    current.impressions += toInt(row.impressions);
    current.clicks += toInt(row.clicks);
    current.conversions += toInt(row.conversions);
    current.revenue += toNumber(row.revenue);
    if (row.conversion_type === 'purchase' || toNumber(row.revenue) > 0) current.conversion_type = 'purchase';
  }
  const merged = [...byKey.values()].map(row => ({
    ...row,
    ctr: row.impressions > 0 ? row.clicks / row.impressions * 100 : 0,
    cpl: row.conversions > 0 ? row.spend / row.conversions : 0,
    roas: row.revenue > 0 && row.spend > 0 ? row.revenue / row.spend : 0,
  }));
  merged.sort((a, b) => b.conversions - a.conversions || a.cpl - b.cpl || b.spend - a.spend);
  return merged;
}

function mergeDailyRows(rows) {
  return mergeBreakdownRows(rows, ['date']).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

module.exports = {
  normalizeAccountIds,
  currencyMultiplierForAccount,
  refreshCurrencyRatesToReport,
  normalizeCurrencyRow,
  normalizeCurrencyRows,
  mergeOverviewRows,
  mergeBreakdownRows,
  mergeDailyRows,
};
