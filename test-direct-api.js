#!/usr/bin/env node
/**
 * Test direct Meta Ads API call for demographics
 */

const https = require('https');
const fs = require('fs');
const TOKEN = fs.readFileSync(process.env.HOME + '/.secrets/pipeboard-api-key.txt', 'utf-8').trim();

const accountId = 'act_160907410994298';

// Test with breakdowns
const url = `https://graph.facebook.com/v22.0/${accountId}/insights?` +
  `access_token=${TOKEN}&` +
  `fields=spend,impressions,clicks,actions,age,gender&` +
  `breakdowns=age,gender&` +
  `time_range={'since':'2025-12-01','until':'2026-02-08'}&` +
  `level=account`;

console.log('Testing direct Meta Ads API for NeedleFree demographics...');

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      if (result.error) {
        console.error('API Error:', result.error.message);
      } else if (result.data) {
        console.log(`Found ${result.data.length} demographic breakdown rows`);
        if (result.data.length > 0) {
          console.log('Sample:', JSON.stringify(result.data[0], null, 2));
        }
      } else {
        console.log('No data returned');
      }
    } catch (e) {
      console.error('Parse error:', e.message);
      console.log('Response:', data.substring(0, 500));
    }
  });
}).on('error', (e) => {
  console.error('Request error:', e.message);
});
