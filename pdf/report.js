'use strict';
// BPC-branded hours PDF, one client at a time.
//
//   node pdf/report.js "Example Client" --client     what the customer may see
//   node pdf/report.js "Example Client" --internal   estimate vs spend, never sent
//
// Run `node build.js` first: this reads dist/data.json, the same dataset the console renders,
// so a PDF can never disagree with the site.
//
// The PDF step drives a headless Chrome over the DevTools protocol, exactly like the
// engagement-report kit. Start one first:
//
//   "C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new ^
//     --remote-debugging-port=9222 --disable-gpu about:blank
//
// If Chrome is not listening the HTML is still written and can be printed by hand.
const fs = require('fs');
const path = require('path');
const { buildHtml } = require('./template');
const { htmlToPdf } = require('./render');

const argv = process.argv.slice(2);
const flag = argv.find((a) => a.startsWith('--'));
const name = argv.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!name || !flag) {
  console.error('Usage: node pdf/report.js "<client name>" --client | --internal');
  console.error('  --client    contracted, used, remaining, invoices. Example Client to send.');
  console.error('  --internal  planned vs actual, staffing, where the time went. Never send.');
  process.exit(1);
}
if (flag !== '--client' && flag !== '--internal') {
  console.error(`Unknown option ${flag}. Say --client or --internal - the report is not the same document.`);
  process.exit(1);
}
const audience = flag === '--client' ? 'client' : 'internal';

const dataFile = path.join(__dirname, '..', 'dist', 'data.json');
if (!fs.existsSync(dataFile)) { console.error('No dist/data.json - run `node build.js` first.'); process.exit(1); }
const D = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

const client = D.clients.find((c) => c.name.toLowerCase() === name.toLowerCase())
  || D.clients.find((c) => c.name.toLowerCase().includes(name.toLowerCase()));
if (!client) {
  console.error(`No client matching "${name}". Try one of:`);
  console.error(D.clients.map((c) => '  ' + c.name).join('\n'));
  process.exit(1);
}

const outDir = path.join(__dirname, '..', 'dist', 'reports');
fs.mkdirSync(outDir, { recursive: true });
const slug = client.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const base = path.join(outDir, `${slug}-${audience}`);

let html;
try {
  html = buildHtml(client, audience, { runDate: D.runDate });
} catch (e) {
  console.error('\n' + e.message + '\n');
  process.exit(2);
}
fs.writeFileSync(base + '.html', html);
console.log('wrote', path.relative(process.cwd(), base + '.html'), `(${(html.length / 1024).toFixed(0)} KB)`);

htmlToPdf(base + '.html', base + '.pdf', process.env.CDP_PORT || 9222)
  .then(() => {
    console.log('wrote', path.relative(process.cwd(), base + '.pdf'), `(${(fs.statSync(base + '.pdf').size / 1024).toFixed(0)} KB)`);
    if (audience === 'internal') console.log('\nInternal only. Do not send this one to the client.');
  })
  .catch((e) => {
    console.error('\nPDF step failed:', e.message);
    console.error('Is headless Chrome listening on :' + (process.env.CDP_PORT || 9222) + '? The HTML above is fine - open it and print to PDF.');
    process.exit(1);
  });
