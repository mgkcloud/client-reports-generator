const assert = require('assert');
const {
  normalizeAccountIds,
  mergeOverviewRows,
  mergeDailyRows,
  mergeBreakdownRows,
  normalizeCurrencyRow,
  refreshCurrencyRatesToReport,
} = require('./account_merge_helpers');

function close(actual, expected, epsilon = 0.0001) {
  assert(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
}

const currencyContext = {
  account_ids: ['act_old_aud', 'act_new_usd'],
  account_currency: {
    act_old_aud: 'AUD',
    act_new_usd: 'USD'
  },
  currency_rates_to_report: {
    AUD: 1,
    USD: 1.5
  }
};

assert.deepStrictEqual(normalizeAccountIds({ account_ids: ['a', 'b', 'a'] }), ['a', 'b']);
assert.deepStrictEqual(normalizeAccountIds('a,b'), ['a', 'b']);

const audRow = normalizeCurrencyRow({ account_id: 'act_old_aud', spend: 100, revenue: 300, cpl: 10 }, 'act_old_aud', currencyContext);
const usdRow = normalizeCurrencyRow({ account_id: 'act_new_usd', spend: 100, revenue: 300, cpl: 10 }, 'act_new_usd', currencyContext);
close(audRow.spend, 100);
close(audRow.revenue, 300);
close(usdRow.spend, 150);
close(usdRow.revenue, 450);
close(usdRow.cpl, 15);
assert.strictEqual(usdRow.source_currency, 'USD');
assert.strictEqual(usdRow.report_currency, 'AUD');

async function runAsyncTests() {
  const refreshed = await refreshCurrencyRatesToReport({
    report_currency: 'AUD',
    account_currency: {
      act_old_aud: 'AUD',
      act_new_usd: 'USD',
      act_eur: 'EUR',
    },
    currency_rates_to_report: {
      AUD: 1,
      USD: 1.1,
      EUR: 1.7,
    },
  }, async (sourceCurrency, targetCurrency) => {
    assert.strictEqual(targetCurrency, 'AUD');
    return sourceCurrency === 'USD' ? 1.52 : 1.64;
  });

  assert.strictEqual(refreshed.report_currency, 'AUD');
  assert.deepStrictEqual(refreshed.currency_rates_to_report, {
    AUD: 1,
    USD: 1.52,
    EUR: 1.64,
  });
  assert.ok(refreshed.currency_rates_updated_at);
}

const overview = mergeOverviewRows([
  { account_id: 'act_old_aud', spend: 100, impressions: 1000, clicks: 100, conversions: 10, revenue: 300, conversion_type: 'purchase' },
  { account_id: 'act_new_usd', spend: 150, impressions: 1000, clicks: 50, conversions: 5, revenue: 450, conversion_type: 'purchase' },
]);
close(overview.spend, 250);
assert.strictEqual(overview.impressions, 2000);
assert.strictEqual(overview.clicks, 150);
assert.strictEqual(overview.conversions, 15);
close(overview.cost_per_conversion, 16.6666667);
close(overview.ctr, 7.5);
close(overview.revenue, 750);
close(overview.roas, 3);
assert.strictEqual(overview.conversion_type, 'purchase');

const daily = mergeDailyRows([
  { date: '2026-06-01', spend: 100, impressions: 1000, clicks: 100, conversions: 10, revenue: 300, conversion_type: 'purchase' },
  { date: '2026-06-01', spend: 150, impressions: 500, clicks: 25, conversions: 5, revenue: 450, conversion_type: 'purchase' },
]);
assert.strictEqual(daily.length, 1);
close(daily[0].spend, 250);
close(daily[0].cpl, 16.6666667);
close(daily[0].roas, 3);

const demo = mergeBreakdownRows([
  { age: '35-44', gender: 'male', spend: 100, impressions: 1000, clicks: 100, conversions: 10, revenue: 300, conversion_type: 'purchase' },
  { age: '35-44', gender: 'male', spend: 150, impressions: 500, clicks: 25, conversions: 5, revenue: 450, conversion_type: 'purchase' },
], ['age', 'gender']);
assert.strictEqual(demo.length, 1);
close(demo[0].spend, 250);
close(demo[0].cpl, 16.6666667);
close(demo[0].roas, 3);

runAsyncTests()
  .then(() => console.log('account merge helper tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
