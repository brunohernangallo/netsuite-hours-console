'use strict';
// Branded hours report. Two audiences, one template, and the difference is not cosmetic:
//
//   audience 'client'    what they bought, used and paid. Nothing they did not agree to.
//   audience 'internal'  what we estimated against what we spent. Never leaves the building.
//
// The cover, palette and type are lifted from the engagement-report kit so a client PDF from
// here matches the branded reports already in use.
const fs = require('fs');
const path = require('path');

const NAVY = '#1F3C51', SAGE = '#619C8A', GOLD = '#F2CC5F', ORANGE = '#EC8842', GRAY = '#D9D9D9';
const ROOT = __dirname;

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const h = (v) => (v == null ? '' : (Math.round(Number(v) * 100) / 100).toLocaleString('en-US'));
const $ = (v) => (v == null ? '' : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const b64 = (f) => { const p = path.join(ROOT, 'assets', f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };

function bar(pct, color) {
  const W = 110, w = Math.min(Math.max(pct, 0), 130) / 130 * W;
  return `<svg viewBox="0 0 ${W} 9" width="${W}" height="9"><rect width="${W}" height="9" rx="3" fill="#EEF2F5"/>` +
    `<rect width="${w.toFixed(1)}" height="9" rx="3" fill="${color}"/></svg>`;
}
const tone = (pct) => (pct == null ? GRAY : pct > 100 ? ORANGE : pct >= 85 ? GOLD : SAGE);

/**
 * @param {{name:string, sows:Array, t:Object}} client  one entry of D.clients
 * @param {'client'|'internal'} audience
 * @param {{runDate:string, period?:string}} meta
 */
function buildHtml(client, audience, meta) {
  const forClient = audience === 'client';
  const rows = client.sows;
  const LOGO = b64('bpc-logo.b64'), HERO = b64('hero-default.b64'), CIRCLES = b64('circles-default.b64');

  // A client PDF may not be produced from an unconfirmed contract figure. This is the whole
  // point of the split: "Purchased" is a contractual claim and only the signed SOW makes it.
  const unconfirmed = rows.filter((r) => r.sold == null);
  if (forClient && unconfirmed.length) {
    const list = unconfirmed.map((r) => r.sow).join(', ');
    throw new Error(
      `Cannot build a client report for ${client.name}: no signed-SOW figure for ${list}.\n` +
      `NetSuite holds no confirmed contracted hours for those SOWs, so "Purchased" would be a guess.\n` +
      `Read the signed SOW and set sold_manual + sold_source in data/data-extras.json, or build the internal report instead.`
    );
  }

  const cstat = (n, l) => `<div class="cstat"><div class="cnum">${n}</div><div class="clab">${l}</div></div>`;
  const stats = forClient
    ? [cstat(h(client.t.contracted) + ' hrs', 'contracted'), cstat(h(client.t.used) + ' hrs', 'used'),
       cstat(h(client.t.remaining) + ' hrs', 'remaining'), cstat($(client.t.unpaid), 'outstanding')]
    : [cstat(String(rows.length), 'open SOWs'), cstat(h(client.t.used) + ' hrs', 'actual'),
       cstat(h(client.t.alloc) + ' hrs', 'staffed'), cstat(h(client.t.ready) + ' hrs', 'unbilled')];

  const cover = `<section class="cover">
    <div class="cover-photo">${HERO ? `<img src="data:image/png;base64,${HERO}"/>` : ''}
      <div class="cover-grad"></div>${CIRCLES ? `<div class="cover-circles" style="background-image:url('data:image/png;base64,${CIRCLES}')"></div>` : ''}</div>
    <div class="cover-top"><span class="dot"></span>Example Client</div>
    <div class="cover-body">
      <div class="cover-eyebrow">${forClient ? 'Confidential' : 'Internal only &middot; do not send'} &middot; ${esc(meta.runDate)}</div>
      <h1 class="cover-title">${forClient ? 'Hours summary' : 'Delivery review'}</h1>
      <div class="cover-rule"></div>
      <p class="cover-sub">${esc(client.name)} &middot; ${rows.length} open ${rows.length === 1 ? 'SOW' : 'SOWs'}.
        ${forClient ? 'Contracted against consumed, with the invoicing behind it.' : 'What we estimated against what we spent. Not for the client.'}</p>
      <div class="cover-stats">${stats.join('')}</div>
    </div>
    <div class="cover-foot"><span>example</span><span>${esc(client.name)}</span></div>
  </section>`;

  // ---- client body: bought / used / left, then the invoices ----------------------------
  const clientBody = () => {
    const sowRows = rows.map((r) => {
      const c = tone(r.pct);
      return `<tr><td>${esc(r.sow)}</td><td class="num">${h(r.contracted)}</td><td class="num">${h(r.used)}</td>` +
        `<td style="padding:3px 8px">${bar(r.pct || 0, c)}</td>` +
        `<td class="num" style="color:${c};font-weight:600">${r.pct == null ? '' : r.pct + '%'}</td>` +
        `<td class="num">${h(r.remaining)}</td></tr>`;
    }).join('');
    const invBlocks = rows.filter((r) => r.invs.length).map((r) => {
      const paid = r.invs.filter((i) => !i.unpaid).length;
      return `<div class="inv-block"><div class="inv-hdr"><div class="inv-hdr-left">
        <div style="font-size:11px;font-weight:600">${esc(r.sow)}</div>
        <span class="inv-period">${r.invs.length} invoices &middot; ${h(r.invHrs)} hrs &middot; ${paid} paid</span>
      </div><div class="inv-total">${$(r.invTotal)}</div></div>
      <table class="billing"><thead><tr><th>Invoice</th><th>Date</th><th class="num">Hours</th><th class="num">Amount</th><th class="num">Outstanding</th></tr></thead><tbody>
      ${r.invs.map((i) => `<tr><td>${esc(i.no)}</td><td>${esc(i.date)}</td><td class="num">${i.hrs == null ? '&mdash;' : h(i.hrs)}</td>` +
        `<td class="num">${$(i.amt)}</td><td class="num" style="color:${i.unpaid > 0 ? ORANGE : '#767676'}">${i.unpaid > 0 ? $(i.unpaid) : ''}</td></tr>`).join('')}
      </tbody></table>
      <div class="cap">A blank hours cell is an invoice that carries no time &mdash; a deposit, a monthly block or a fixed fee.</div></div>`;
    }).join('');
    return `<h2>Contracted against consumed</h2>
      <table><thead><tr><th>SOW</th><th class="num">Contracted</th><th class="num">Used</th><th></th><th class="num">Consumed</th><th class="num">Remaining</th></tr></thead>
      <tbody>${sowRows}<tr class="total-row"><td>Total</td><td class="num">${h(client.t.contracted)}</td><td class="num">${h(client.t.used)}</td><td></td>
      <td class="num">${client.t.pct == null ? '' : client.t.pct + '%'}</td><td class="num">${h(client.t.remaining)}</td></tr></tbody></table>
      <div class="cap">Hours as recorded in NetSuite on ${esc(meta.runDate)}. Non-billable time is tracked separately and does not count against the contract.</div>
      <h2>Invoicing</h2>${invBlocks || '<p class="cap">No invoices raised yet.</p>'}`;
  };

  // ---- internal body: estimate vs spend, staffing, where the time went -----------------
  const internalBody = () => {
    const pvaRows = rows.map((r) => {
      const gap = r.pvaGap, c = gap > 0 ? ORANGE : SAGE;
      return `<tr><td>${esc(r.sow)}</td><td class="num">${r.plannedTime ? h(r.plannedTime) : '&mdash;'}</td>` +
        `<td class="num">${h(r.actualTime)}</td>` +
        `<td class="num" style="color:${r.plannedTime ? c : '#767676'};font-weight:600">${r.plannedTime ? (gap > 0 ? '+' : '') + h(gap) : ''}</td>` +
        `<td class="num">${r.pvaPct == null ? '' : r.pvaPct + '%'}</td><td class="num">${h(r.allocTime)}</td></tr>`;
    }).join('');
    const landing = rows.filter((r) => r.tasks.length).map((r) => `<div class="card">
      <div class="ct">${esc(r.sow)} <span style="font-weight:400;color:#767676">&middot; last entry ${esc(r.lastTime || '')} &middot; ${h(r.h30)} hrs in 30d &middot; ${r.people} people</span></div>
      <table class="billing"><tbody>${r.tasks.map((t) => `<tr><td>${esc(t[0])}</td><td class="num">${h(t[1])}</td><td class="num" style="color:#767676">${esc(t[2])}</td></tr>`).join('')}</tbody></table></div>`).join('');
    return `<h2>What we estimated against what we spent</h2>
      <table><thead><tr><th>SOW</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Gap</th><th class="num">Of estimate</th><th class="num">Staffed</th></tr></thead>
      <tbody>${pvaRows}</tbody></table>
      <div class="cap"><strong>Planned</strong> is <code>timetype = P</code>, the PMO's planned time entries. <strong>Actual</strong> is <code>timetype = A</code>.
      <strong>Staffed</strong> is <code>timetype = B</code>, generated from the resource allocation &mdash; a separate forecast. A dash means no estimate was ever loaded.</div>
      <h2>Where the hours are landing</h2>${landing || '<p class="cap">No time booked in the last 60 days.</p>'}`;
  };

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500;600;700&display=swap');
  @page { margin: 15mm 11mm 13mm; }
  * { box-sizing: border-box; }
  body { font-family:'Sarabun',Arial,sans-serif; font-weight:300; color:${NAVY}; font-size:11px; line-height:1.55; -webkit-font-smoothing:antialiased; }
  .brand { display:flex; align-items:flex-end; justify-content:space-between; border-bottom:2px solid ${NAVY}; padding-bottom:9px; margin-bottom:16px; }
  .brand img { height:24px; } .brand .eyebrow { font-size:8.5px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:${forClient ? SAGE : ORANGE}; }
  h2 { font-weight:600; font-size:13px; color:${NAVY}; margin:16px 0 6px; padding-bottom:4px; border-bottom:1px solid ${GRAY}; page-break-after:avoid; }
  p { margin:5px 0; } code { font-family:ui-monospace,Consolas,monospace; font-size:8.5px; }
  table { border-collapse:collapse; width:100%; margin:5px 0; font-size:9.5px; }
  th { background:${NAVY}; color:#fff; font-weight:500; text-align:left; padding:4px 7px; font-size:9px; }
  td { padding:3px 7px; border-bottom:1px solid #EEEEEE; } tr:nth-child(even) td { background:#FAFAFA; }
  tr.total-row td { background:#F3F6F9; font-weight:600; border-top:1px solid #CDD8E0; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .card { border:1px solid #EEEEEE; border-radius:8px; padding:10px 13px; margin:7px 0; page-break-inside:avoid; }
  .card .ct { font-size:9.5px; font-weight:600; margin-bottom:5px; } .cap { font-size:9px; color:#767676; margin-top:4px; }
  .inv-block { border:1px solid #DDE6EE; border-radius:7px; padding:12px 14px; margin:8px 0; page-break-inside:avoid; }
  .inv-hdr { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:9px; padding-bottom:8px; border-bottom:1px solid #EEF2F5; }
  .inv-hdr-left { display:flex; flex-direction:column; gap:3px; } .inv-period { font-size:9px; color:#767676; }
  .inv-total { font-size:18px; font-weight:600; font-variant-numeric:tabular-nums; align-self:center; }
  table.billing th { font-size:8.5px; padding:3px 6px; } table.billing td { font-size:9px; padding:2px 6px; }
  .cover { position:relative; width:100vw; height:255mm; background:${NAVY}; color:#fff; overflow:hidden; page-break-after:always; margin:-15mm -11mm 0; }
  .cover-photo { position:absolute; inset:0 0 0 50%; } .cover-photo img { width:100%; height:100%; object-fit:cover; filter:saturate(.65) contrast(1.05); }
  .cover-grad { position:absolute; inset:0; background:linear-gradient(90deg,${NAVY} 0%,rgba(31,60,81,.55) 42%,rgba(31,60,81,.18) 100%); }
  .cover-circles { position:absolute; inset:0; background-position:center right; background-size:cover; mix-blend-mode:screen; opacity:.42; }
  .cover-top { position:absolute; top:20mm; left:18mm; font-size:12px; font-weight:500; display:flex; align-items:center; gap:8px; z-index:3; }
  .cover-top .dot { width:9px; height:9px; border-radius:50%; background:${GOLD}; }
  .cover-body { position:absolute; left:18mm; right:52%; top:78mm; z-index:3; }
  .cover-eyebrow { font-size:11px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:${forClient ? GOLD : ORANGE}; margin-bottom:14px; }
  .cover-title { font-weight:300; font-size:40px; line-height:1.08; letter-spacing:-.02em; color:#fff; margin:0; }
  .cover-rule { width:54px; height:3px; background:${GOLD}; margin:18px 0; }
  .cover-sub { font-size:12px; line-height:1.6; color:rgba(255,255,255,.82); max-width:330px; }
  .cover-stats { display:flex; flex-wrap:wrap; gap:10px 26px; margin-top:30px; }
  .cstat .cnum { font-weight:500; font-size:24px; color:${GOLD}; line-height:1; }
  .cstat .clab { font-size:9px; color:rgba(255,255,255,.72); margin-top:4px; }
  .cover-foot { position:absolute; bottom:18mm; left:18mm; right:18mm; display:flex; justify-content:space-between; font-size:9.5px; color:rgba(255,255,255,.55); z-index:3; }
  .stamp { border:1.5px solid ${ORANGE}; background:#FFF8F4; border-radius:8px; padding:9px 13px; margin-bottom:12px; font-size:9.5px; }
</style></head><body>
  ${cover}
  <div class="brand"><img src="data:image/png;base64,${LOGO}" alt="Example Client"/>
    <span class="eyebrow">${esc(client.name)} &nbsp;&middot;&nbsp; ${esc(meta.runDate)} &nbsp;&middot;&nbsp; ${forClient ? 'Confidential' : 'Internal only'}</span></div>
  ${forClient ? '' : `<div class="stamp"><strong>Internal only &mdash; do not send to the client.</strong>
    This report compares our own estimate against what we spent. The client agreed to a scope and a total, not to our estimate,
    so sending it invites an argument about hours they have already paid for. What they may see is the client report.</div>`}
  ${forClient ? clientBody() : internalBody()}
</body></html>`;
}

module.exports = { buildHtml };
