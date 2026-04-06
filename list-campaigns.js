#!/usr/bin/env node

/**
 * List all campaigns in the Meta Ads account
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

async function main() {
  const CONFIG_PATH = path.join(__dirname, 'config.json');
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

  // Use NeedleFree config to get account ID (act_6614401774771)
  const clientConfig = config.clients.find(c => c.name.includes('NeedleFree'));
  const accountId = clientConfig.account_id;

  console.log(`📊 Listing all campaigns for account: ${accountId}`);
  console.log('');

  // Get Pipeboard token
  const tokenFile = config.pipeboard_token_file.replace('~', process.env.HOME);
  const token = fs.readFileSync(tokenFile, 'utf-8').trim();

  // Fetch campaign-level insights using tools/call
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'get_insights',
      arguments: {
        object_id: accountId,
        time_range: {
          since: '2025-12-01',
          until: '2026-02-08'
        },
        fields: 'campaign_name,campaign_id,status,spend,impressions,clicks,actions,cost_per_action_type',
        level: 'campaign'
      }
    }
  });

  const endpoint = new URL(config.pipeboard_endpoint);

  const result = await new Promise((resolve, reject) => {
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

  // Extract content text
  let text = '';
  if (result && result.content && Array.isArray(result.content)) {
    text = result.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  } else {
    text = JSON.stringify(result);
  }

  // Parse JSON lines
  const rows = text.split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter(row => row !== null);

  console.log(`Found ${rows.length} campaign insights:\n`);

  // Group by campaign name
  const campaigns = new Map();

  for (const row of rows) {
    const name = row.campaign_name || 'Unknown';
    const id = row.campaign_id || 'Unknown';
    const status = row.status || 'Unknown';
    const spend = parseFloat(row.spend || 0);

    if (!campaigns.has(name)) {
      campaigns.set(name, {
        name,
        id,
        status,
        spend,
        impressions: parseInt(row.impressions || 0),
        clicks: parseInt(row.clicks || 0),
        leads: 0
      });
    } else {
      const existing = campaigns.get(name);
      existing.spend += spend;
      existing.impressions += parseInt(row.impressions || 0);
      existing.clicks += parseInt(row.clicks || 0);
    }

    // Count leads
    if (Array.isArray(row.actions)) {
      for (const action of row.actions) {
        if (action.action_type === 'lead') {
          campaigns.get(name).leads += parseInt(action.value || 0);
        }
      }
    }
  }

  // Sort by spend (descending)
  const sorted = Array.from(campaigns.values()).sort((a, b) => b.spend - a.spend);

  for (const campaign of sorted) {
    console.log(`📌 ${campaign.name}`);
    console.log(`   ID: ${campaign.id}`);
    console.log(`   Status: ${campaign.status}`);
    console.log(`   Spend: $${campaign.spend.toFixed(2)}`);
    console.log(`   Impressions: ${campaign.impressions.toLocaleString()}`);
    console.log(`   Clicks: ${campaign.clicks.toLocaleString()}`);
    console.log(`   Leads: ${campaign.leads}`);
    console.log('');
  }
}

main().catch(console.error);
