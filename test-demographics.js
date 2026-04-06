#!/usr/bin/env node
/**
 * Test direct Meta Ads API for demographics with breakdowns
 */

const https = require('https');
const fs = require('fs');
const TOKEN = fs.readFileSync(process.env.HOME + '/.secrets/meta-ads-token.txt', 'utf-8').trim();

function testDemographics(accountId, accountName) {
  console.log(`\n📊 Testing ${accountName} demographics with direct Meta Ads API...`);

  const timeRange = encodeURIComponent(JSON.stringify({ since: '2025-12-01', until: '2026-02-08' }));

  const url = `https://graph.facebook.com/v22.0/${accountId}/insights?` +
    `access_token=${TOKEN}&` +
    `fields=spend,impressions,clicks,actions&` +
    `breakdowns=age,gender&` +
    `time_range=${timeRange}&` +
    `level=account&limit=50`;

  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        if (result.error) {
          console.error(`❌ API Error:`, result.error.message);
          if (result.error.type === 'OAuthException') {
            console.error('   Token may be expired or invalid');
          }
        } else if (result.data) {
          console.log(`✅ Found ${result.data.length} total rows`);

          // Filter to only rows with age/gender breakdowns
          const breakdowns = result.data.filter(r => r.age || r.gender);
          console.log(`✅ Found ${breakdowns.length} demographic breakdown rows`);

          if (breakdowns.length > 0) {
            console.log('\nSample demographic breakdowns:');
            breakdowns.slice(0, 5).forEach(row => {
              const spend = parseFloat(row.spend || 0);
              console.log(`  - ${row.age || 'Unknown'} ${row.gender || 'Unknown'}: $${spend.toFixed(2)} spend, ${row.impressions || 0} impr`);
            });
          } else {
            console.log('⚠️  No demographic breakdowns available');
          }
        } else {
          console.log('⚠️  No data returned');
        }
      } catch (e) {
        console.error('Parse error:', e.message);
        console.log('Response:', data.substring(0, 500));
      }
    });
  }).on('error', (e) => {
    console.error('Request error:', e.message);
  });
}

// Test both accounts
testDemographics('act_160907410994298', 'NeedleFree');
testDemographics('act_747429766205314', 'Box Divvy');
