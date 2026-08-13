'use strict';
/**
 * Who worked on each invoice.
 *
 *   node scripts/pull-invoice-detail.js
 *
 * Writes data/data-invoice-detail.json: for every invoice, the consultants behind it and how
 * many hours each one contributed. `node build.js` then renders it under each invoice row.
 *
 * WHY THIS IS A SCRIPT AND NOT A CHAT
 * -----------------------------------
 * Measured 12-Aug-2026 through the NetSuite MCP connector: the query below returns instantly
 * for ONE project and times out at six. There are 2,881 invoice-person-task combinations
 * across the open book, so the only way to collect them is one project at a time, sequentially,
 * with retries - which is this file, not a conversation.
 *
 * CREDENTIALS (the one thing still missing, as of 12-Aug-2026)
 * -----------------------------------------------------------
 * Needs NetSuite token-based auth for account <YOUR_ACCOUNT_ID> - an integration record plus an access
 * token, with the SuiteAnalytics Workbook / SuiteQL permission. Put them in a .env next to
 * this file:
 *
 *   NS_ACCOUNT=<YOUR_ACCOUNT_ID>
 *   NS_CONSUMER_KEY=...      NS_CONSUMER_SECRET=...
 *   NS_TOKEN_ID=...          NS_TOKEN_SECRET=...
 *
 * They are requested from whoever administers NetSuite integrations. Until they exist this
 * script cannot run, and the console says so at the foot of the invoice section rather than
 * pretending the data is coming.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV = {};
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m) ENV[m[1]] = m[2].trim();
  }
}
const need = ['NS_ACCOUNT', 'NS_CONSUMER_KEY', 'NS_CONSUMER_SECRET', 'NS_TOKEN_ID', 'NS_TOKEN_SECRET'];
const missing = need.filter((k) => !ENV[k] && !process.env[k]);
if (missing.length) {
  console.error('Missing NetSuite credentials: ' + missing.join(', '));
  console.error('See the header of this file - they have to be requested from the NetSuite admin.');
  process.exit(1);
}
const cfg = Object.fromEntries(need.map((k) => [k, process.env[k] || ENV[k]]));

// ---- OAuth 1.0a, which is what NetSuite's SuiteQL REST endpoint speaks -------------------
const nonce = () => crypto.randomBytes(16).toString('hex');
const enc = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function authHeader(url, method) {
  const p = {
    oauth_consumer_key: cfg.NS_CONSUMER_KEY, oauth_nonce: nonce(),
    oauth_signature_method: 'HMAC-SHA256', oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: cfg.NS_TOKEN_ID, oauth_version: '1.0',
  };
  const base = [method, enc(url.split('?')[0]),
    enc(Object.keys(p).sort().map((k) => enc(k) + '=' + enc(p[k])).join('&'))].join('&');
  const key = enc(cfg.NS_CONSUMER_SECRET) + '&' + enc(cfg.NS_TOKEN_SECRET);
  p.oauth_signature = crypto.createHmac('sha256', key).update(base).digest('base64');
  return 'OAuth realm="' + cfg.NS_ACCOUNT + '", ' +
    Object.keys(p).sort().map((k) => enc(k) + '="' + enc(p[k]) + '"').join(', ');
}

const HOST = 'https://' + cfg.NS_ACCOUNT.replace('_', '-') + '.suitetalk.api.netsuite.com';
const URL_Q = HOST + '/services/rest/query/v1/suiteql';

async function suiteql(sql, attempt = 1) {
  const res = await fetch(URL_Q, {
    method: 'POST',
    headers: { Authorization: authHeader(URL_Q, 'POST'), 'Content-Type': 'application/json', Prefer: 'transient' },
    body: JSON.stringify({ q: sql }),
  });
  if (!res.ok) {
    if (attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * attempt)); return suiteql(sql, attempt + 1); }
    throw new Error('SuiteQL ' + res.status + ': ' + (await res.text()).slice(0, 300));
  }
  return (await res.json()).items || [];
}

// One project at a time. Six at once times out; one is instant.
const QUERY = (job) => `
  SELECT t.tranid AS inv, x.who AS who, x.hrs AS hrs, x.task AS task
  FROM (
    SELECT c.invoice AS i, e.entityid AS who, SUM(c.quantity) AS hrs, pt.title AS task
    FROM charge c
      INNER JOIN timebill tb ON tb.id = c.timerecord
      INNER JOIN employee e ON e.id = tb.employee
      LEFT JOIN projecttask pt ON pt.id = tb.casetaskevent
    WHERE tb.customer = ${job} AND c.invoice IS NOT NULL AND tb.timetype = 'A'
    GROUP BY c.invoice, e.entityid, pt.title
  ) x
  INNER JOIN transaction t ON t.id = x.i`;

(async () => {
  const jobs = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'data-invoices.json'), 'utf8')).jobs);
  const out = {};
  for (let k = 0; k < jobs.length; k++) {
    const job = jobs[k];
    process.stdout.write(`\r${k + 1}/${jobs.length}  job ${job}   `);
    let rows = [];
    try { rows = await suiteql(QUERY(job)); }
    catch (e) { console.error('\n  job ' + job + ' failed: ' + e.message); continue; }
    for (const r of rows) {
      const inv = r.inv;
      (out[inv] = out[inv] || []).push([r.who, Math.round(Number(r.hrs) * 100) / 100, r.task || '']);
    }
  }
  for (const inv of Object.keys(out)) out[inv].sort((a, b) => b[1] - a[1]);
  const file = path.join(__dirname, '..', 'data', 'data-invoice-detail.json');
  fs.writeFileSync(file, JSON.stringify({
    _note: 'Consultants and tasks behind each invoice, from charge -> timebill with timetype = A. ' +
           'Row = [consultant, hours, task]. Collected one project at a time because the query times out otherwise.',
    invoices: out,
  }, null, 1));
  console.log('\nwrote ' + path.relative(process.cwd(), file) + '  (' + Object.keys(out).length + ' invoices)');
})();
