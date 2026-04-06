#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

async function testAccount() {
  const CONFIG_PATH = path.join(__dirname, 'config.json');
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const tokenFile = config.pipeboard_token_file.replace('~', process.env.HOME);
  const token = fs.readFileSync(tokenFile, 'utf-8').trim();

  const accountId = 'act_6614401774771';

  // Test with account level first
  console.log(`Testing account level for ${accountId}...`);

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
        fields: 'spend,impressions,clicks,actions',
        level: 'account'
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
          reject(new Error(`Failed to parse response: ${data.substring(0, 1000)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(payload);
    req.end();
  });

  let text = '';
  if (result && result.content && Array.isArray(result.content)) {
    text = result.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  } else {
    text = JSON.stringify(result);
  }

  console.log('Raw response:');
  console.log(text.substring(0, 1000));
  console.log('');
}

testAccount().catch(console.error);
