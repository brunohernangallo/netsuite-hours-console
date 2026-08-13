/**
 * Builds the BPC Hours Console  a single self-contained HTML app that reuses the
 * Customer Hub shell (C:\apps\nspbhub\src\console.css + portal.css + ds-tokens.css).
 *
 * Per SOW it puts the numbers that never agree in NetSuite side by side:
 *   Sold       hours on the SOW's own opportunity (job.custentity_bpc_primaryopportunity)
 *   CO         won change orders linked to that SOW
 *   Plan       projecttask.plannedwork on the root tasks (what a PM typed at kickoff)
 *   Allocated  job.allocatedtime (what the PM has staffed = the PMO's EAC view)
 *   Used       projecttask.actualwork, billable only
 *   Billed / Ready  charge.stage, i.e. what is invoiced vs sitting unbilled
 *
 * The gap between them IS the report. Nothing is inferred, and a figure that cannot be
 * true (sold below what is already used) is suppressed rather than published.
 *
 *   node hours-report/build.js
 */
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const DATA = path.join(DIR, "data");
const RUN_DATE = "2026-08-11";
const TODAY = new Date("2026-08-11T00:00:00");

const rd = (p) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const nsRows = rd(path.join(DATA, "data-jobs.json"));
const extras = rd(path.join(DATA, "data-extras.json")).jobs;
const billing = rd(path.join(DATA, "data-billing.json")).jobs;
const activity = rd(path.join(DATA, "data-activity.json")).jobs;
const links = rd(path.join(DATA, "data-links.json"));
const plannedT = rd(path.join(DATA, "data-planned.json")).jobs;
const rtmT = rd(path.join(DATA, "data-rtm.json")).jobs;
const peopleT = rd(path.join(DATA, "data-people.json")).jobs;
const billT = rd(path.join(DATA, "data-billable.json")).jobs;
const invoicesByJob = rd(path.join(DATA, "data-invoices.json")).jobs;
// The signed SOW as a PDF in the NetSuite file cabinet. There is no field joining a file to
// a project, so these are matched by file name and each carries a confidence flag. A candidate
// is shown with a question mark, never as "the contract". See the note in data-sowpdf.json.
const sowPdf = rd(path.join(DATA, "data-sowpdf.json")).jobs;

const n = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
const clientOf = (s) => String(s).split("|")[0].trim();
const usDate = (s) => (s ? new Date(String(s).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2") + "T00:00:00") : null);
const days = (s) => { const d = usDate(s); return d ? Math.round((d - TODAY) / 86400000) : null; };

const rows = nsRows.map((r) => {
  const id = String(r.job_id);
  const x = extras[id] || {}, b = billing[id] || {}, a = activity[id] || {}, l = links.open[id] || [];
  const pt = plannedT[id] || [0, 0, 0];
  const rt = rtmT[id] || [];
  const who = peopleT[id] || [];
  // Billable vs non-billable comes from the time record itself, not from a task called
  // "Non-Billable". The task-name rule needs that task to exist AND the plan to be current,
  // and projecttask.actualwork only moves once time is approved - it was 41 hrs light on one
  // project. timebill.isbillable is set on every entry, so it cannot drift.
  const bl = billT[id];
  const cos = (Array.isArray(r.cos) ? r.cos : []).map((c) => ({ tranid: c.tranid, id: c.id, hrs: n(c.hrs) }));
  // A change order is only added when it really adds scope. Some COs are the whole contract
  // restated: they repeat the SOW's own line items and deposit, so summing them invents hours
  // the client never bought. Where that has been checked by hand, co_manual overrides the sum
  // and co_source says why - see Example Client, flagged by Example Client on 12-Aug-2026.
  // A change order whose hours equal the SOW's own hours is the contract restated, not extra
  // scope: a change order repeating the SOW line for line, deposit included. Adding it
  // doubles the contract. Detected here; anything subtler still needs co_manual.
  const soldRaw = x.sold_manual != null ? x.sold_manual : x.sold;
  const clones = soldRaw ? cos.filter((c) => c.hrs && Math.abs(c.hrs - soldRaw) <= Math.max(0.5, soldRaw * 0.01)) : [];
  const co = x.co_manual != null ? n(x.co_manual)
    : n(cos.filter((c) => clones.indexOf(c) < 0).reduce((s, c) => s + (c.hrs || 0), 0));
  const coNote = x.co_source || (clones.length && x.co_manual == null
    ? clones.map((c) => c.tranid).join(', ') + ' repeats the SOW total of ' + n(soldRaw) + ' hrs line for line, so it restates the contract rather than adding to it, and is not counted.'
    : null);
  const plan = n(r.planned) || 0;
  const used = bl ? n(bl[0]) : (n(r.consumed) || 0);

  // --- sanity gate on the "sold" figure -------------------------------------------------
  // The primary opportunity is not always the SOW: on Example Client it points at a 5.6-hr
  // change order, on Example Client at a 1.28-hr line. Publishing that as "sold" produces
  // a number nobody can believe, which poisons the whole report. So a sold figure is only
  // shown when it can be true: at least what has already been booked, and in the same
  // ballpark as the plan. Otherwise it is suppressed and flagged for a human to fill in
  // from the signed SOW.
  let sold = x.sold_manual != null ? x.sold_manual : x.sold, soldFrom = x.sold_manual != null ? "sow" : "opp";
  let soldBad = null;
  if (sold != null && x.sold_manual == null && plan && sold < plan * 0.4) {
    // A sold figure BELOW what has been booked is not an impossible number - it is an overrun,
    // and suppressing it is how an overrun gets published as healthy. Example Client
    // (12-Aug-2026): the opportunity said 228.25, 267.75 was booked, the old gate threw the
    // 228.25 away, fell back to the 294.25 plan, added a cloned 228.25 change order and printed
    // 522.5 contracted. Example Client: "no son 525, son unas 210". Only a figure that is a fraction
    // of the plan is still read as a change order rather than the SOW.
    soldBad = "The linked opportunity shows " + n(sold) + " hrs against a plan of " + plan + " - it looks like a change order, not the SOW.";
    sold = null; soldFrom = null;
  }
  if (sold == null) soldFrom = null;

  // Sold is a REFERENCE, not the basis. It comes from an opportunity that in this account is
  // routinely a change order, a restatement or empty, and it is only trustworthy once someone
  // has read the signed SOW. Remaining and Consumption therefore run on the project plan plus
  // the change orders that genuinely add scope - the numbers a PM can act on today. Where Sold
  // and Plan disagree the row says so, and the commercial figure waits for the signed document.
  // The contract beats the plan. Example Client: opportunity 226.92, plan 294.25 - the plan
  // is what a PM typed, the opportunity is what was sold, and Example Client's read of the SOW
  // ("unas 210") backs the opportunity. Falls through to the plan only when no sold figure
  // survives, and that case is labelled unconfirmed everywhere it appears.
  const base = sold != null ? sold : plan;
  const contracted = n(base + co);
  const remaining = n(contracted - used);
  const pct = contracted ? Math.round((used / contracted) * 100) : null;

  const o = {
    id: r.job_id, client: clientOf(r.job_name), sow: String(r.job_name).replace(/\s*\|\s*/g, " / "),
    ms: String(r.jobtype) === "2", open: true,
    start: r.startdate || null, end: r.enddate || null, renewal: r.renewal_date || null,
    autoRenew: r.auto_renew === "T", rollover: r.rollover_cap,
    sold, soldFrom, soldBad, soldNote: x.sold_source || null, opp: x.opp || null,
    rtm: l[0] || null, sowLink: l[1] || null, pdf: sowPdf[id] || null,
    co, cos, coNote, plan, alloc: n(x.alloc), used, approved: n(r.approved),
    nbPlan: n(r.nb_planned), nbUsed: bl ? n(bl[1]) : n(r.nb_actual),
    usedPlanTask: n(r.consumed), usedFrom: bl ? 'timebill.isbillable' : 'projecttask.actualwork',
    billed: n(b.billed), ready: n(b.ready), invoices: b.inv || 0, invAmt: n(b.amt),
    unpaid: n(b.unpaid), openInv: b.open || 0, lastInv: b.last || null,
    lastTime: a.last || null, h30: n(a.h30), future: a.future || 0, people: a.ppl || 0,
    tasks: a.tasks || [],
    invs: (invoicesByJob[id] || []).map((v) => ({ no: v[0], date: v[1], amt: n(v[2]), unpaid: n(v[3]), hrs: v[4] == null ? null : n(v[4]) })),
    // Delivery side. plannedTime = timetype P, the PMO's own forecast and what Example Client's
    // EAC workbook calls Planned Hours. actualTime = timetype A. allocTime = timetype B, rows
    // generated from the resource allocation - a third and separate forecast.
    plannedTime: n(pt[0]), actualTime: n(pt[1]), allocTime: n(pt[2]),
    // Straight off the RTM record - NetSuite's own stored totals, not recomputed here. cwOpp
    // accumulates every change order as it closes, so it is the contract value including COs.
    // Money stays money: it is never turned back into hours.
    who,
    // The RTM is read in full and shown beside the live figures rather than hidden: it is the
    // screen the PMO works from, so the console has to say what it holds and how old that is.
    rtmId: rt[0] != null ? rt[0] : null, cwOpp: n(rt[1]), allocEst: n(rt[2]),
    rtmAllocHrs: n(rt[3]), rtmActualAmt: n(rt[5]), rtmActualHrs: n(rt[6]), rtmSaved: rt[7] || null,
    contracted, remaining, pct,
  };
  // Where the sources disagree. Each of these is two NetSuite fields that ought to say the
  // same thing and do not - the reason this console exists rather than one number on a slide.
  o.checks = [];
  {
    const pc = (a, b) => Math.abs(a - b) / Math.max(a, b);
    if (o.sold != null && o.plan && pc(o.sold, o.plan) > 0.05)
      o.checks.push(["plan vs SOW", "the project plan says " + n(o.plan) + " hrs, the SOW opportunity says " + n(o.sold)]);
    if (o.allocTime && o.alloc && Math.abs(o.allocTime - o.alloc) > 1)
      o.checks.push(["allocation vs its time rows", "job.allocatedtime is " + n(o.alloc) + " but the timetype B rows add to " + n(o.allocTime)]);
    if (o.actualTime && o.used && Math.abs(o.actualTime - o.used) > 1)
      o.checks.push(["time vs plan actuals", "timebill has " + n(o.actualTime) + " actual hrs, projecttask.actualwork has " + n(o.used)]);
    if (o.plannedTime && o.plan && pc(o.plannedTime, o.plan) > 0.05)
      o.checks.push(["planned time vs plan", "planned time entries add to " + n(o.plannedTime) + ", the plan says " + n(o.plan)]);
    if (o.cos.length && o.co === 0 && !o.coNote)
      o.checks.push(["change orders not counted", o.cos.length + " won CO(s) are excluded"]);
  }
  o.planPct = o.plan ? Math.round(o.used / o.plan * 100) : null;
  o.pvaGap = o.plannedTime ? n(o.actualTime - o.plannedTime) : null;
  o.pvaPct = o.plannedTime ? Math.round((o.actualTime / o.plannedTime) * 100) : null;
  // Reconciliation: the same work counted three ways. They should agree; where they do not,
  // the difference is named on screen rather than smoothed over.
  o.invHrs = n(o.invs.reduce((s, i) => s + (i.hrs || 0), 0));
  o.invTotal = n(o.invs.reduce((s, i) => s + (i.amt || 0), 0));
  o.invUnpaid = n(o.invs.reduce((s, i) => s + (i.unpaid || 0), 0));
  o.gapBooked = n(o.used - (o.billed + o.ready));   // booked but not even approved for billing
  o.gapInvoiced = n(o.billed - o.invHrs);           // marked billed but not on any invoice line
  o.renewalDays = o.renewal ? days(o.renewal) : null;
  o.lastTimeDays = o.lastTime ? days(o.lastTime) : null;
  return o;
});

/** Everything the console can flag, computed once so counts and lists always agree. */
for (const r of rows) {
  const f = [];
  if (r.remaining != null && r.remaining < 0) f.push("over");
  else if (r.pct != null && r.pct >= 85) f.push("low");
  if (r.sold == null) f.push("nosold");
  if (r.sold != null && r.plan && Math.abs(r.sold - r.plan) > 0.05 * Math.max(r.sold, r.plan)) f.push("planmismatch");
  if (r.alloc != null && r.sold != null && r.alloc > (r.sold + r.co) * 1.05) f.push("overstaffed");
  if (r.cos.some((c, i, a) => a.some((o, j) => j !== i && o.hrs === c.hrs))) f.push("dupco");
  if (r.future > 0) f.push("futuretime");
  if (r.ready > 0) f.push("unbilled");
  if (r.openInv > 0) f.push("unpaid");
  if (r.lastTimeDays != null && r.lastTimeDays < -45 && r.remaining > 0) f.push("stale");
  if (r.renewalDays != null && r.renewalDays < 0) f.push("expired");
  else if (r.renewalDays != null && r.renewalDays <= 60) f.push("renewing");
  if (r.ms && !r.renewal && !r.end) f.push("noterm");
  r.issues = f;
}

const closed = links.closed.map((c) => ({
  ...c, client: clientOf(c.name), sow: String(c.name).replace(/\s*\|\s*/g, " / "),
  over: c.used > c.plan, pct: c.plan ? Math.round((c.used / c.plan) * 100) : null,
}));

const clients = [...rows.reduce((m, r) => (m.get(r.client) ? m.get(r.client).push(r) : m.set(r.client, [r]), m), new Map())]
  .map(([name, sows]) => {
    const sum = (k) => n(sows.reduce((s, r) => s + (r[k] || 0), 0));
    const t = { contracted: sum("contracted"), used: sum("used"), alloc: sum("alloc"), plan: sum("plan"),
      co: sum("co"), billed: sum("billed"), ready: sum("ready"), unpaid: sum("unpaid"), nbUsed: sum("nbUsed") };
    t.remaining = n(t.contracted - t.used);
    t.pct = t.contracted ? Math.round((t.used / t.contracted) * 100) : null;
    const cl = closed.filter((c) => c.client === name);
    const rank = Math.max(...sows.map((r) => (r.issues.includes("over") ? 3 : r.issues.includes("low") ? 2 : 1)));
    return { name, sows: sows.sort((a, b) => (b.pct || 0) - (a.pct || 0)), closed: cl, t, rank };
  })
  .sort((a, b) => b.rank - a.rank || (b.t.pct || 0) - (a.t.pct || 0));

const data = { runDate: RUN_DATE, rows, closed, clients,
  totals: { clients: clients.length, sows: rows.length,
    contracted: n(rows.reduce((s, r) => s + (r.contracted || 0), 0)),
    used: n(rows.reduce((s, r) => s + (r.used || 0), 0)),
    alloc: n(rows.reduce((s, r) => s + (r.alloc || 0), 0)),
    unpaid: n(rows.reduce((s, r) => s + (r.unpaid || 0), 0)),
    ready: n(rows.reduce((s, r) => s + (r.ready || 0), 0)) } };

const asciiJson = (o) => JSON.stringify(o).replace(
  new RegExp(String.fromCharCode(91,94,32,45,126,93),"g"),
  (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hours  Example Client</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--navy-900:#1F3C51;--rail:#142c3d;--green-500:#619C8A;--green-700:#047050;--gold-500:#F2CC5F;
 --orange-600:#EC8842;--danger:#C9512E;--g-800:#434343;--g-700:#595959;--g-600:#767676;--g-500:#999;
 --g-400:#BFBFBF;--g-300:#D9D9D9;--g-200:#EEE;--g-100:#F3F3F3;--g-50:#FAFAFA;
 --font:'Sarabun',Arial,system-ui,sans-serif;--mono:'JetBrains Mono',Menlo,Consolas,monospace}
*{box-sizing:border-box}
[hidden]{display:none !important}
html,body{height:100%}
body{margin:0;font-family:var(--font);font-weight:300;color:var(--navy-900);background:#fff;-webkit-font-smoothing:antialiased}
button{font:inherit}
.console{display:grid;grid-template-columns:248px 1fr;grid-template-rows:minmax(0,1fr);height:100vh;overflow:hidden}
.rail{background:var(--rail);color:rgba(255,255,255,.92);display:flex;flex-direction:column;padding:16px 14px 14px;overflow:hidden;position:relative}
.rail::after{content:"";position:absolute;left:-40%;bottom:-10%;width:80%;height:40%;background:radial-gradient(circle,rgba(97,156,138,.18),rgba(97,156,138,0) 65%)}
.rail-brand{padding:6px 8px 4px;position:relative;z-index:1}
.rail-brand .bn{font-size:15px;font-weight:600;color:#fff;line-height:1.15}
.rail-brand .bn .accent{color:var(--gold-500)}
.rail-brand .sub{font-weight:300;font-size:12px;color:rgba(255,255,255,.6)}
.rail-org{display:flex;align-items:center;gap:10px;margin:16px 4px 12px;padding:10px 12px;border-radius:11px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);position:relative;z-index:1}
.rail-org .ava{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;font-weight:700;font-size:13px;color:#fff;background:var(--green-500);flex:none}
.rail-org .nm{font-size:13px;font-weight:600;color:#fff}
.rail-org .rl{font-size:11px;color:rgba(255,255,255,.52)}
.rail-group-label{font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.36);padding:16px 11px 6px;position:relative;z-index:1}
.nav-item{display:flex;align-items:center;gap:11px;padding:10px 13px;border-radius:11px;font-size:13.5px;font-weight:500;color:rgba(255,255,255,.86);cursor:pointer;border:none;background:none;width:100%;text-align:left;position:relative;z-index:1;margin-bottom:3px;transition:background 120ms,color 120ms}
.nav-item:hover{background:rgba(255,255,255,.08);color:#fff}
.nav-item.active{background:#fff;color:var(--navy-900);font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.22)}
.nav-item .ico{width:18px;text-align:center;color:rgba(255,255,255,.62);flex:none}
.nav-item.active .ico{color:var(--green-700)}
.nav-item .cnt{margin-left:auto;font-size:11px;font-family:var(--mono);color:rgba(255,255,255,.5)}
.nav-item.active .cnt{color:var(--g-600)}
.rail-spacer{flex:1}
.rail-foot{display:flex;align-items:center;gap:10px;padding:12px 8px 2px;margin-top:10px;border-top:1px solid rgba(255,255,255,.1);position:relative;z-index:1}
.rail-foot .ava{width:30px;height:30px;border-radius:50%;background:var(--green-500);color:#fff;display:grid;place-items:center;font-weight:600;font-size:13px;flex:none}
.rail-foot .nm{font-size:12.5px;font-weight:600;color:#fff}
.rail-foot .em{font-size:11px;color:rgba(255,255,255,.5);max-width:120px;overflow:hidden;text-overflow:ellipsis}
.rail-foot .out{margin-left:auto;background:none;border:none;color:rgba(255,255,255,.6);cursor:pointer;padding:6px;border-radius:7px}
.rail-foot .out:hover{color:#fff;background:rgba(255,255,255,.08)}
.console-main{display:flex;flex-direction:column;min-width:0;height:100%}
.topbar{height:58px;flex:none;display:flex;align-items:center;gap:14px;padding:0 24px;background:rgba(255,255,255,.82);backdrop-filter:blur(8px);border-bottom:1px solid var(--g-300);z-index:5}
.crumbs{font-size:13.5px;color:var(--g-600);display:flex;align-items:center;gap:7px;white-space:nowrap}
.crumbs .sep{color:var(--g-400)}.crumbs .cur{color:var(--navy-900);font-weight:600}
.crumbs a{color:var(--g-600);text-decoration:none;cursor:pointer}.crumbs a:hover{color:var(--green-700)}
.topbar-search{margin-left:6px;display:flex;align-items:center;gap:8px;width:320px;max-width:32vw;background:#fff;border:1px solid var(--g-400);border-radius:9px;padding:8px 12px;color:var(--g-600);box-shadow:inset 0 1px 2px rgba(31,60,81,.06)}
.topbar-search:focus-within{border-color:var(--green-700);box-shadow:0 0 0 3px rgba(97,156,138,.18)}
.topbar-search:focus-within{border-color:var(--green-500);box-shadow:0 0 0 3px rgba(97,156,138,.25)}
.topbar-search input{border:none;outline:none;font:inherit;font-size:13.5px;width:100%;background:transparent;color:var(--navy-900)}
.topbar-spacer{flex:1}
.topbar-live{font-size:12px;color:var(--g-500);white-space:nowrap}
.topbar-dot{width:7px;height:7px;border-radius:50%;background:var(--green-500);display:inline-block;margin-right:7px;vertical-align:1px}
.beta{flex:none;padding:9px 24px;font-size:12.5px;line-height:1.5;background:rgba(242,204,95,.16);border-bottom:1px solid rgba(242,204,95,.5);color:var(--g-800)}
.beta b{color:var(--navy-900);font-weight:600}
.content{flex:1;min-height:0;overflow:auto;background:#fff;scroll-padding-top:96px}
/* Column headers stay put while 63 rows go past. */
table.grid thead th{position:sticky;top:0;z-index:6;background:#fff;
  box-shadow:0 1px 0 var(--navy-900),0 6px 10px -8px rgba(31,60,81,.35)}
.section>table thead th,.section table thead th{position:sticky;top:0;z-index:3;background:var(--g-50);
  box-shadow:0 1px 0 var(--g-200)}
.beta{position:sticky;top:0;z-index:8}
/* The banner is sticky, so the headers park underneath it rather than on top of it. */
table.grid thead th{top:0}
.pane{padding:26px 40px 64px;max-width:1440px}
h1.page{margin:0 0 4px;font-size:26px;font-weight:300;letter-spacing:-.01em}
p.lede{margin:0 0 22px;font-size:14px;color:var(--g-700);max-width:900px;line-height:1.6}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.card{background:#fff;border:1px solid var(--g-300);border-radius:10px;padding:13px 15px 12px;
  box-shadow:0 1px 3px rgba(31,60,81,.09);position:relative;overflow:hidden}
.card:before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:var(--g-300)}
.card.info:before{background:var(--navy-900)}.card.warn:before{background:var(--gold-500)}
.card.alert:before{background:var(--danger)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:12px}
.card .k{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--g-600);font-weight:600}
.card .v{font-size:27px;font-weight:300;margin-top:5px;line-height:1.05}
.card .s{font-size:11.5px;color:var(--g-500);margin-top:3px}
.card.alert{border-color:rgba(201,81,46,.3)}.card.alert .v{color:var(--danger)}
.card.warn{border-color:rgba(242,204,95,.55)}.card.warn .v{color:#a5791c}
.card.info .v{color:var(--green-700)}
.card.click{cursor:pointer}.card.click:hover{box-shadow:0 4px 16px rgba(31,60,81,.1)}
.note{font-size:13px;color:var(--g-800);background:var(--g-50);border:1px solid var(--g-200);border-left:3px solid var(--gold-500);border-radius:10px;padding:14px 18px;margin-bottom:22px;line-height:1.65}
.note b{font-weight:600}.note code{font-family:var(--mono);font-size:12px;background:var(--g-100);padding:1px 5px;border-radius:4px}
.note dt{font-weight:600;color:var(--navy-900);margin-top:8px}
.note dd{margin:2px 0 0;color:var(--g-700)}
.section{background:#fff;border:1px solid var(--g-200);border-radius:12px;margin-bottom:28px;overflow:hidden;box-shadow:0 1px 3px rgba(31,60,81,.07)}
/* A page of stacked panels reads as one long blur unless each one is unmistakably a block.
   The navy header bar gives every section a hard top edge, and the gap below gives it a
   hard bottom edge. 12-Aug-2026: "no esta muy claro donde empieza y termina algo". */
.section-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;padding:12px 18px;background:var(--navy-900);color:#fff}
.section-head h2{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em;color:#fff}
.section-head .tot,.section-head .tot b{color:rgba(255,255,255,.82)}
.section .sub+table,.section table{margin-top:0}
.section>table thead th{position:sticky;top:0;background:var(--g-50);z-index:1}
.section-head .tot{display:flex;gap:16px;font-size:12.5px;color:var(--g-700);flex-wrap:wrap}
.section-head .tot b{font-weight:600;color:var(--navy-900);font-family:var(--mono)}
.section .sub{padding:11px 18px;font-size:12.5px;color:var(--g-700);line-height:1.6;background:var(--g-50);border-bottom:1px solid var(--g-200)}
.section tbody tr:nth-child(even) td{background:#FBFCFD}
.section tbody tr:hover td{background:#F2F6F8}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-weight:600;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--g-600);padding:9px 12px;border-bottom:1px solid var(--g-200);white-space:nowrap;background:#fff}
td{padding:11px 12px;border-bottom:1px solid var(--g-100);vertical-align:top}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--g-50)}
tr.is-over{background:rgba(201,81,46,.045)}tr.is-low{background:rgba(242,204,95,.09)}
.num{text-align:right;font-family:var(--mono);font-size:12.5px;white-space:nowrap}
.nav-sec{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--g-500);padding:14px 16px 4px;font-weight:600}
.split{display:flex;align-items:center;gap:10px;margin:22px 0 10px;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--g-500);font-weight:600}
.split:after{content:"";flex:1;height:1px;background:var(--g-200)}
.num .bar{display:inline-block;vertical-align:middle;width:52px;margin-left:6px}
th[title],.card[title]{cursor:help}
.trust{border:1px solid var(--g-300);border-left-width:5px;border-radius:10px;padding:14px 18px;margin-bottom:22px;background:#fff}
.trust .tv{font-size:15px;font-weight:600;margin-bottom:4px}
.trust p{margin:0 0 8px;font-size:12.5px;color:var(--g-700);line-height:1.6}
.trust .tf{font-size:11px;color:var(--g-500);line-height:1.7}
.trust.ok{border-left-color:var(--green-500)}.trust.ok .tv{color:var(--green-700)}
.trust.warn{border-left-color:var(--gold-500)}.trust.warn .tv{color:#8a6d1f}
.trust.alert{border-left-color:var(--danger)}.trust.alert .tv{color:var(--danger)}
table.grid{border-collapse:separate;border-spacing:0}
table.grid th{vertical-align:bottom;white-space:nowrap;padding:10px 14px 8px;border-bottom:2px solid var(--navy-900)}
table.grid th .fld{font-family:var(--mono);font-size:9px;font-weight:400;letter-spacing:0;
  text-transform:none;color:var(--g-500);margin-top:3px;white-space:nowrap}
table.grid td{padding:9px 14px;border-bottom:1px solid var(--g-200);vertical-align:middle}
table.grid tbody tr:hover td{background:#F5F8FA}
td.cl{max-width:190px}
td.cl .t{font-weight:600;font-size:13.5px;white-space:normal;line-height:1.3}
td.sw{max-width:260px}
td.sw .swn{display:block;font-size:12.5px;color:var(--g-800);line-height:1.35}
td.sw .meta{font-size:10.5px}
a.nl{color:inherit;text-decoration:none;border-bottom:1px dotted var(--g-400)}
a.nl:hover{border-bottom-color:var(--navy-900);color:var(--navy-900)}
tr.cl-row td{background:#FBFBFC;color:var(--g-600)}
tr.cl-row .name{color:var(--g-700)}
.fsel{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:600;
  letter-spacing:.06em;text-transform:uppercase;color:var(--g-500)}
.fsel select{font:inherit;font-size:14px;font-weight:400;letter-spacing:0;text-transform:none;
  color:var(--navy-900);background:#fff;border:1px solid var(--g-300);border-radius:6px;
  padding:9px 34px 9px 12px;min-width:330px;font-weight:500;cursor:pointer;appearance:none;
  background-image:linear-gradient(45deg,transparent 50%,var(--g-500) 50%),linear-gradient(135deg,var(--g-500) 50%,transparent 50%);
  background-position:calc(100% - 17px) 18px,calc(100% - 12px) 18px;background-size:5px 5px;background-repeat:no-repeat}
.fsel select:focus{outline:2px solid var(--green-500);outline-offset:1px}
.fclear{margin-left:8px;border:0;background:none;font-size:12px;color:var(--g-600);cursor:pointer;text-decoration:underline}
.fclear:hover{color:var(--navy-900)}
.cos{display:inline-flex;gap:4px;margin-left:6px;vertical-align:middle}
.co{font-family:var(--mono);font-size:10px;padding:1px 5px;border-radius:3px;background:#EDF3F0;
  color:var(--green-700);text-decoration:none;border:1px solid #D8E6E0}
.co:hover{background:#DFEBE6}
.co.out{background:#F5F5F5;color:var(--g-500);border-color:var(--g-300);text-decoration:line-through}
.dd{position:relative;display:inline-block}
.ddb{display:inline-flex;align-items:center;gap:9px;background:#fff;border:1px solid var(--g-300);
  border-radius:7px;padding:9px 14px;font:inherit;font-size:14px;font-weight:500;color:var(--navy-900);cursor:pointer}
.ddb:hover{border-color:var(--navy-900)}
.ddb .fl{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--g-500)}
.ddb .fn{font-family:var(--mono);font-size:12px;color:var(--g-600);background:var(--g-100);border-radius:4px;padding:1px 6px}
.ddb .cv{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;
  border-top:5px solid var(--g-500);margin-left:2px}
.ddp{display:none;position:absolute;z-index:30;top:calc(100% + 6px);left:0;min-width:340px;background:#fff;
  border:1px solid var(--g-300);border-radius:9px;box-shadow:0 12px 28px -12px rgba(31,60,81,.4);padding:6px}
.dd.open .ddp{display:block}
.ddh{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--g-500);
  padding:10px 10px 5px;display:flex;justify-content:space-between;align-items:baseline}
.ddx{font-size:10px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--g-400)}
.ddi{display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:13px}
.ddi:hover{background:var(--g-50)}
.ddi input{accent-color:var(--green-700);width:15px;height:15px;cursor:pointer}
.ddi span{flex:1}
.ddi b{font-family:var(--mono);font-size:11.5px;font-weight:400;color:var(--g-500)}
.ddclear{margin:4px 10px 6px;border:0;background:none;font-size:12px;color:var(--g-600);cursor:pointer;text-decoration:underline}
.wblk{border-bottom:1px solid var(--g-200);padding:16px 18px 20px}
.wblk:last-child{border-bottom:0}
.wh{font-size:13.5px;font-weight:600;color:var(--navy-900);margin-bottom:2px}
.wh .meta{display:block;font-weight:400;font-size:11.5px;color:var(--g-600);margin-top:2px}
.wsub{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--g-500);
  margin:16px 0 6px;display:flex;justify-content:space-between;align-items:baseline}
.wx{font-size:10px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--g-400)}
tr.total-row td{background:#F3F6F9;border-top:1px solid var(--g-300);font-weight:500}
table.grid th .sortb{background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer;
  letter-spacing:inherit;text-transform:inherit}
table.grid th .sortb:hover{color:var(--navy-900);text-decoration:underline}
/* Column headers: darker, and visibly interactive. */
table.grid thead th{background:#EEF2F5;color:var(--navy-900);font-size:10.5px;font-weight:700;
  border-bottom:2px solid var(--g-400)}
table.grid th .sortb{display:inline-flex;align-items:center;gap:5px;background:none;border:0;padding:2px 0;
  font:inherit;color:inherit;cursor:pointer;letter-spacing:inherit;text-transform:inherit}
table.grid th .sortb:hover{color:var(--green-700)}
table.grid th .sortb:hover .sa{color:var(--green-700)}
.sa{font-size:9px;color:var(--g-400);line-height:1}
.sa.on{color:var(--navy-900);font-size:8px}
table.grid thead th .fld{color:var(--g-600);font-weight:500}
.fbar{display:flex;align-items:center;flex-wrap:wrap;gap:14px}
.fset{display:inline-flex;align-items:center;gap:6px}
.fl{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--g-500);margin-right:2px}
.fnote{font-size:11.5px;color:var(--g-500)}
.fbar_{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.fchip{border:1px solid var(--g-200);background:#fff;border-radius:14px;padding:4px 11px;font-size:12px;color:var(--g-600);cursor:pointer}
.fchip:hover{border-color:var(--navy-500)}
.fchip.on{background:var(--navy-500);border-color:var(--navy-500);color:#fff}
.fchip .fn{font-variant-numeric:tabular-nums;opacity:.7;margin-left:3px}
.card .sub,.card .fld{font-family:var(--mono)}
.fld{font-family:ui-monospace,Consolas,monospace;font-size:9px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--g-400);margin-top:2px}
.num.strong{font-weight:500}.num.nb{color:var(--g-500);font-style:italic}
.sortb{background:none;border:none;padding:0;font:inherit;color:inherit;cursor:pointer;letter-spacing:inherit;text-transform:inherit}
.sortb:hover{color:var(--green-700)}.num.muted{color:var(--g-500)}.num.neg{color:var(--danger);font-weight:500}
.name{max-width:380px}
.name a.t{color:var(--navy-900);text-decoration:none;font-weight:400;border-bottom:1px solid var(--g-300)}
.name a.t:hover{color:var(--green-700);border-color:var(--green-500)}
.meta{display:block;font-size:11px;color:var(--g-600);margin-top:3px;font-family:var(--mono)}
.meta.txt{font-family:var(--font);font-style:italic;color:var(--g-700)}
.lnk{display:inline-block;margin:5px 6px 0 0;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--g-600);text-decoration:none;border-bottom:1px dotted var(--g-400)}
.lnk:hover{color:var(--green-700);border-color:var(--green-500)}
/* A signed-SOW PDF matched by file name and not confirmed. It must not read like the contract. */
.lnk.maybe{color:var(--amber-700,#8a6100);border-bottom-style:dashed;border-color:var(--amber-500,#d99e00)}
.chip{display:inline-block;margin:5px 4px 0 0;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:600}
.chip.over{background:rgba(201,81,46,.12);color:var(--danger)}
.chip.low{background:rgba(242,204,95,.28);color:#8a6d10}
.chip.gap{background:var(--g-100);color:var(--g-700)}
.chip.risk{background:rgba(236,136,66,.16);color:#a5541c}
.chip.time{background:rgba(31,60,81,.08);color:var(--navy-900)}
.chip.ok{background:rgba(97,156,138,.16);color:var(--green-700)}
.pct{white-space:nowrap;font-size:12.5px;font-family:var(--mono)}
.bar{display:inline-block;width:70px;height:6px;background:var(--g-200);border-radius:99px;overflow:hidden;vertical-align:middle;margin-left:8px}
.bar-fill{display:block;height:100%;border-radius:99px}
.bar-fill.ok{background:var(--green-500)}.bar-fill.low{background:var(--gold-500)}
.bar-fill.over{background:var(--danger)}.bar-fill.na{background:var(--g-400)}
.empty{padding:34px;text-align:center;color:var(--g-500);font-size:14px}
.name button.t,.name button.cl{background:none;border:none;padding:0;text-align:left;cursor:pointer;font:inherit;color:var(--navy-900)}
.name button.cl{font-weight:600;font-size:13px}
.name .t.plain{border:none;font-weight:400}
.refs{display:block;margin-top:6px;font-size:10.5px;color:var(--g-500);text-transform:uppercase;letter-spacing:.05em}
.name button.t{border-bottom:1px solid var(--g-300)}
.name button.t:hover,.name button.cl:hover{color:var(--green-700);border-color:var(--green-500)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:1100px){.grid2{grid-template-columns:1fr}}
.chart{display:flex;flex-direction:column;gap:9px}
.hbar{display:grid;grid-template-columns:minmax(120px,1.1fr) 2.2fr auto;gap:12px;align-items:center}
.hb-l{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hb-l a.t{color:var(--navy-900);text-decoration:none;border-bottom:1px solid var(--g-300)}
.hb-l a.t:hover{color:var(--green-700)}
.hb-s{display:block;font-size:10.5px;color:var(--g-600);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hb-t{height:10px;background:var(--g-100);border-radius:5px;overflow:hidden}
.hb-f{display:block;height:100%;border-radius:0 4px 4px 0}
.hb-v{font-family:var(--mono);font-size:12px;color:var(--g-800);min-width:52px;text-align:right}
.strip{display:flex;gap:2px;align-items:flex-end}
.sg{min-width:0;background:none;border:none;padding:0;cursor:pointer;text-align:left;font:inherit}
.sg:hover .sb{filter:brightness(1.08)}
.sg:hover .sl b{color:var(--green-700)}
.sb{height:34px;border-radius:4px}
.sl{font-size:11.5px;color:var(--g-700);margin-top:7px;line-height:1.35}
.sl b{font-family:var(--mono);color:var(--navy-900);font-size:13px;display:block}
.strip-foot{font-size:11.5px;color:var(--g-600);margin-top:12px}
.dl{display:inline-block;margin-right:16px}.dl b{font-family:var(--mono)}
.clientlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.ccard{text-align:left;background:#fff;border:1px solid var(--g-200);border-radius:12px;padding:15px 17px;cursor:pointer;box-shadow:0 1px 2px rgba(31,60,81,.05)}
.ccard:hover{box-shadow:0 4px 16px rgba(31,60,81,.1);border-color:var(--g-300)}
.ccard .cn{font-size:15px;font-weight:500;margin-bottom:8px}
.ccard .cm{font-size:12px;color:var(--g-600);font-family:var(--mono);display:flex;gap:12px;flex-wrap:wrap}
.ccard .cb{margin-top:10px}
.btn{display:inline-flex;align-items:center;gap:7px;padding:8px 15px;border-radius:999px;border:1px solid var(--g-300);background:#fff;font-size:13px;font-weight:600;color:var(--navy-900);cursor:pointer}
.btn:hover{border-color:var(--navy-900);background:var(--g-50)}
.btn.primary{background:var(--green-700);border-color:var(--green-700);color:#fff}
.btn.primary:hover{background:#066647}
.det-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;flex-wrap:wrap;margin-bottom:18px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12.5px;margin-top:10px}
.kv dt{color:var(--g-600)}.kv dd{margin:0;font-family:var(--mono)}
footer.legal{color:var(--g-600);font-size:12px;line-height:1.7;padding-top:6px;max-width:940px}
/* ---- print: the client-facing sheet ---- */
@media print{
  .rail,.topbar,.beta,.noprint{display:none !important}
  .console{display:block;height:auto;overflow:visible}
  .content{overflow:visible}
  .pane{padding:0;max-width:none}
  .section{break-inside:avoid;box-shadow:none;border-color:var(--g-300)}
  body{font-size:11pt}
  .printonly{display:block !important}
  @page{margin:14mm}
}
.printonly{display:none}
@media (max-width:880px){
  .console{grid-template-columns:64px 1fr}
  .rail-brand .bn,.rail-org .nm,.rail-org .rl,.nav-item span.lbl,.nav-item .cnt,.rail-group-label,.rail-foot .nm,.rail-foot .em{display:none}
  .topbar-search{display:none}.pane{padding:18px 16px 48px}
}
/* ---- login (from the Customer Hub, portal.css .login-*) ---- */
.login-screen{display:grid;grid-template-columns:1.05fr 1fr;height:100vh;width:100vw;overflow:hidden}
.login-left{background:var(--rail);color:#fff;position:relative;overflow:hidden;display:flex;flex-direction:column;justify-content:space-between;padding:60px 68px}
.login-left::after{content:"";position:absolute;right:-200px;bottom:-220px;width:640px;height:640px;border-radius:50%;background:radial-gradient(circle,rgba(97,156,138,.16),rgba(97,156,138,0) 65%)}
.login-brand .brand-name{font-size:21px;font-weight:700;letter-spacing:-.02em;color:#fff;position:relative;z-index:1}
.login-brand .accent{color:var(--gold-500)}
.login-tag{position:relative;z-index:1;max-width:460px}
.login-tag h1{font-weight:300;font-size:42px;line-height:1.12;letter-spacing:-.02em;margin:0;color:#fff}
.login-tag h1 .hl{color:var(--gold-500)}
.login-tag p{font-size:16px;line-height:1.6;color:rgba(255,255,255,.72);margin:20px 0 0;max-width:42ch}
.login-foot{position:relative;z-index:1;font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.5)}
.login-right{display:grid;place-items:center;padding:40px;background:var(--g-50)}
.login-card{width:100%;max-width:380px;display:flex;flex-direction:column}
.login-card h2{font-weight:300;font-size:26px;margin:0 0 8px;color:var(--navy-900)}
.login-card .intro{font-size:13.5px;color:var(--g-700);line-height:1.6;margin:0 0 22px}
.login-sso{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;padding:12px;border-radius:999px;border:1px solid var(--g-300);background:#fff;font-size:14px;font-weight:600;color:var(--navy-900);cursor:pointer}
.login-sso:hover{border-color:var(--navy-900);background:var(--g-50)}
.login-demo{text-align:center;margin-top:20px;padding:10px 14px;border-radius:9px;background:rgba(4,112,80,.07);border:1px solid rgba(4,112,80,.15);font-size:12.5px;color:var(--g-800);line-height:1.5}
.login-help{text-align:center;font-size:12.5px;color:var(--g-500);margin-top:14px}
.login-err{color:var(--danger);font-size:13px;margin:14px 0 0;text-align:center}
@media (max-width:820px){.login-screen{grid-template-columns:1fr}.login-left{display:none}}

/* ---- spreadsheet skin ------------------------------------------------------------- */
.content{background:var(--g-100)}
.pane{padding:20px 24px 80px;max-width:none}
h1.page{font-size:19px;font-weight:600;letter-spacing:-.01em;margin:0 0 10px}
p.lede{font-size:12.5px;line-height:1.55;color:var(--g-600);max-width:none;margin:0 0 14px}
p.lede b{color:var(--g-800);font-weight:600}

table.grid{width:100%;background:#fff;border:1px solid var(--g-300);border-radius:8px;
  border-collapse:separate;border-spacing:0;font-size:12.5px;
  box-shadow:0 1px 2px rgba(31,60,81,.05)}
table.grid thead th{position:sticky;top:0;z-index:6;background:#F7F8F9;text-align:right;
  padding:0 12px;height:34px;vertical-align:middle;white-space:nowrap;
  font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--g-600);
  border-bottom:1px solid var(--g-300);border-right:1px solid var(--g-200);box-shadow:none}
table.grid thead th:first-child,table.grid thead th:nth-child(2){text-align:left}
table.grid thead th:last-child{border-right:0}
table.grid thead th .fld{display:none}
table.grid td{height:34px;padding:0 12px;border-bottom:1px solid var(--g-200);
  border-right:1px solid var(--g-200);vertical-align:middle;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
table.grid td:last-child{border-right:0}
table.grid tbody tr:last-child td{border-bottom:0}
table.grid tbody tr:hover td{background:#F6F9FB}
table.grid tr.is-over td{background:#FDF6F3}
table.grid tr.is-over:hover td{background:#FBEEE9}

/* the client is a name, not a button */
td.cl{max-width:180px}
td.cl .t{background:none;border:0;padding:0;font-weight:500;font-size:12.5px;color:var(--navy-900);
  cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;display:block;text-align:left}
td.cl .t:hover{color:var(--green-700);text-decoration:underline}
td.sw{max-width:250px;color:var(--g-700)}
td.sw .swn{display:inline;font-size:12.5px}
td.sw .meta{display:none}

table.grid td.num{font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums}
table.grid td.num.muted{color:var(--g-500)}
table.grid td.num.strong{font-weight:500;color:var(--navy-900)}
table.grid td.num.neg{color:var(--danger)}
table.grid .bar{width:44px;height:5px;border-radius:3px;margin-left:8px}

/* status reads as a dot when it is fine, a pill only when it is not */
table.grid .chip{font-size:10.5px;padding:2px 7px;border-radius:4px;font-weight:500}
table.grid .chip.ok{background:none;color:var(--g-500);padding:0;font-weight:400}
table.grid .chip.ok:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;
  background:var(--green-500);margin-right:6px;vertical-align:middle}

.fbar{gap:5px;margin-bottom:12px}
.fchip{border-radius:5px;font-size:11.5px;padding:4px 9px;background:#fff}
</style>
</head>
<body>
<div class="login-screen" id="login">
  <div class="login-left">
    <div class="login-brand"><div class="brand-name">Bryant<span class="accent">Park</span> Consulting</div></div>
    <div class="login-tag"><h1>Every SOW, every hour, <span class="hl">in one place</span>.</h1>
      <p>Sold, planned, staffed, used and billed  side by side, live from NetSuite. Internal to Example Client.</p></div>
    <div class="login-foot">Example Client &middot; Hours Console</div>
  </div>
  <div class="login-right"><div class="login-card">
    <h2>Sign in</h2>
    <p class="intro">This console holds contract and margin data for every client. Access is limited to Example Client accounts.</p>
    <button class="login-sso" id="btn-google">
      <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden style="flex:none">
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/>
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
        <path fill="#4CAF50" d="M24 44c5.5 0 10.4-2.1 14.1-5.5l-6.5-5.5c-2 1.5-4.7 2.5-7.6 2.5-5.2 0-9.6-3.3-11.2-7.9l-6.6 5.1C9.6 39.6 16.2 44 24 44z"/>
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.5 5.5C40.9 36.5 44 30.8 44 24c0-1.3-.1-2.3-.4-3.5z"/>
      </svg> Continue with Google</button>
    <div class="login-err" id="login-err" hidden></div>
    <div class="login-demo">Example Client accounts only. Client accounts cannot reach this console.</div>
    <div class="login-help">No access? Ask your administrator.</div>
  </div></div>
</div>

<div class="console" id="app" hidden>
  <aside class="rail noprint">
    <div class="rail-brand"><div class="bn">Bryant<span class="accent">Park</span><br><span class="sub">Hours Console</span></div></div>
    <div class="rail-org"><div class="ava">GSA</div><div><div class="nm">GSA Operations</div><div class="rl">Internal &middot; all clients</div></div></div>
    <button class="nav-item active" data-view="portfolio"><span class="lbl">Portfolio</span></button>
    <button class="nav-item" data-view="help"><span class="lbl">Help</span></button>
    <div class="rail-spacer"></div>
    <div class="rail-foot"><div class="ava" id="me-ava">&middot;&middot;</div><div><div class="nm" id="me-name"></div><div class="em" id="me-mail"></div></div><button class="out" id="btn-out" title="Sign out">&#9211;</button></div>
  </aside>
  <main class="console-main">
    <div class="topbar noprint">
      <div class="crumbs"><a id="crumb-root">Hours</a><span class="sep">/</span><span class="cur" id="crumb">Portfolio</span></div>
      <label class="topbar-search"><input id="q" type="search" placeholder="Filter by client, SOW or NetSuite id" autocomplete="off"></label>
      <div class="topbar-spacer"></div>
      <div class="topbar-live"><span class="topbar-dot"></span>NetSuite <YOUR_ACCOUNT_ID> &middot; ${RUN_DATE}</div>
    </div>
    <div class="content"><div class="pane" id="pane"></div></div>
  </main>
</div>
<script id="data" type="application/json">${asciiJson(data)}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const JOB = i => 'https://<YOUR_ACCOUNT_ID>.app.netsuite.com/app/accounting/project/project.nl?id=' + i;
const INV = (t) => "https://<YOUR_ACCOUNT_ID>.app.netsuite.com/app/common/search/searchresults.nl?searchtype=Transaction&Transaction_NUMBERTEXT=" + encodeURIComponent(t) + "&Transaction_NUMBERTEXTtype=IS&style=NORMAL";
const OPP = i => 'https://<YOUR_ACCOUNT_ID>.app.netsuite.com/app/accounting/transactions/opprtnty.nl?id=' + i;
const RTM = i => 'https://<YOUR_ACCOUNT_ID>.app.netsuite.com/app/common/custom/custrecordentry.nl?rectype=1435&id=' + i;
// The signed SOW straight out of the file cabinet. p = [fileId, fileName, confidence, hash,
// note]. The hash is part of the media URL and NetSuite will not serve the file without it.
const PDF = p => 'https://<YOUR_ACCOUNT_ID>.app.netsuite.com/core/media/media.nl?id=' + p[0] + '&c=<YOUR_ACCOUNT_ID>&h=' + p[3] + '&_xt=.pdf';
const pdfTip = p => p[1] + (p[2] ? '' : '  --  MATCHED BY NAME, NOT CONFIRMED. ' + (p[4] || ''));
const f = v => v == null ? '' : Number(v).toLocaleString('en-US',{maximumFractionDigits:2});
const money = v => v == null ? '' : '$' + Number(v).toLocaleString('en-US',{maximumFractionDigits:0});
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const ST = {1:'Complete',4:'Closed',17:'On hold',28:'Accounting review'};

const LBL = {over:['over','Over budget'],low:['low','Running low'],nosold:['gap','Sold hours not in NetSuite'],
 planmismatch:['gap','Plan 0 sold'],overstaffed:['risk','Staffed above contract'],dupco:['gap','Duplicate change order'],
 expired:['over','Term ended'],renewing:['time','Renews soon'],noterm:['gap','No term loaded'],
 futuretime:['time','Planned time entries'],unbilled:['time','Unbilled hours'],unpaid:['time','Open invoices'],
 stale:['gap','No time in 45+ days']};
const KEY = ['over','low','expired','renewing','overstaffed','dupco','planmismatch','nosold','futuretime','stale'];
const chips = r => r.issues.filter(i=>KEY.includes(i)).map(i=>'<span class="chip '+LBL[i][0]+'">'+LBL[i][1]+'</span>').join('');
const bar = p => { const w=Math.max(0,Math.min(100,p||0)), c=p==null?'na':p>100?'over':p>=85?'low':'ok';
  return '<span class="bar"><span class="bar-fill '+c+'" style="width:'+w+'%"></span></span>'; };
const cls = r => r.issues.includes('over')?' class="is-over"':r.issues.includes('low')?' class="is-low"':'';

const delta = (k, v, label, fmtv) => {
  if (!v) return '';
  const up = v > 0, s = (fmtv || f)(Math.abs(v));
  return '<span class="dl"><b>' + (up ? '+' : '') + s + '</b> ' + label + '</span>';
};


// Links are references you follow to VERIFY a number, so they sit at the end of the row
// behind an explicit label -- never on the client or SOW name, which opens the detail.
const refs = r => '<span class="refs noprint">References: ' +
  '<a class="lnk" href="' + JOB(r.id) + '" target="_blank" rel="noopener">NetSuite project</a>' +
  (r.opp ? '<a class="lnk" href="' + OPP(r.opp) + '" target="_blank" rel="noopener">Opportunity</a>' : '') +
  (r.rtm ? '<a class="lnk" href="' + RTM(r.rtm) + '" target="_blank" rel="noopener">RTM</a>' : '') +
  (r.pdf ? '<a class="lnk' + (r.pdf[2] ? '' : ' maybe') + '" href="' + PDF(r.pdf) +
    '" target="_blank" rel="noopener" title="' + esc(pdfTip(r.pdf)) + '">Signed SOW (PDF)' +
    (r.pdf[2] ? '' : ' ?') + '</a>' : '') +
  (r.sowLink ? '<a class="lnk" href="' + r.sowLink + '" target="_blank" rel="noopener">SOW on Drive</a>' : '') +
  '</span>';

function srow(r, showClient) {
  const J = JOB(r.id), R = r.rtm ? RTM(r.rtm) : null;
  const lnk = (href, v, why) => href
    ? '<a class="nl" href="' + href + '" target="_blank" rel="noopener" title="' + esc(why) + '">' + v + '</a>'
    : v;
  return '<tr' + cls(r) + '><td class="name">' +
    (showClient ? '<button class="t" data-client="' + esc(r.client) + '">' + esc(r.sow) + '</button>'
                : '<span class="t plain">' + esc(r.sow) + '</span>') +
    '<span class="meta">NS ' + r.id + (r.start ? ' &middot; from ' + r.start : '') +
      (r.lastTime ? ' &middot; last time ' + r.lastTime : '') + '</span>' +
    chips(r) + (r.soldBad ? '<span class="warnnote">' + esc(r.soldBad) + '</span>' : '') +
    refs(r) + '</td>' +
    '<td class="num muted">' + lnk(J, f(r.plan), 'projecttask.plannedwork - open the NetSuite project') + '</td>' +
    '<td class="num muted">' + lnk(R, f(r.alloc), R ? 'job.allocatedtime - open RTM ' + r.rtm : 'job.allocatedtime') + '</td>' +
    '<td class="num strong">' + lnk(J, f(r.used), 'projecttask.actualwork - open the NetSuite project') + '</td>' +
    '<td class="num nb">' + (r.nbUsed ? f(r.nbUsed) : '') + '</td>' +
    '<td class="pct" title="' + esc('[ projecttask.actualwork / projecttask.plannedwork ]') + '">' +
      (r.planPct == null ? '' : r.planPct + '%') + bar(r.planPct) + '</td></tr>';
}
const SORTK = {plan:'plan',alloc:'alloc',used:'used',nb:'nbUsed',pct:'planPct'};
let sortBy = 'name', sortDir = 1;
function sorted(rows){
  if(!sortBy) return rows;
  if(sortBy==='name') return rows.slice().sort((a,b)=>
    (a.client+a.sow).localeCompare(b.client+b.sow)*sortDir);
  const k = SORTK[sortBy];
  return rows.slice().sort((a,b)=>{
    const x=a[k], y=b[k];
    if(x==null&&y==null) return 0; if(x==null) return 1; if(y==null) return -1;
    return (x-y)*sortDir;
  });
}
const arrow = k => sortBy===k ? (sortDir<0?' &darr;':' &uarr;') : '';
const TIP = {sold:'sold',co:'co',plan:'plan',alloc:'allocated',used:'booked',nb:'nonbill',rem:'remaining',pct:'consumed'};
const th = (k,label) => { const d = FLD[TIP[k]]; return '<th class="num"'+(d?' title="'+esc('[ '+d[0]+' ]' + NL + NL + d[1])+'"':'')+
  '><button class="sortb" data-sort="'+k+'">'+label+arrow(k)+'</button></th>'; };
const HEAD2 = () => '<thead><tr><th><button class="sortb" data-sort="name">SOW'+arrow('name')+'</button></th>'+
 th('plan','Plan')+th('alloc','Allocated')+th('used','Used')+th('nb','Non-bill.')+
 '<th title="'+esc('[ projecttask.actualwork / projecttask.plannedwork ]' + NL + NL + 'How much of the project plan has been delivered. Measured against the plan, never against the contract or against money.')+'"><button class="sortb" data-sort="pct">Used vs plan'+arrow('pct')+'</button></th></tr></thead>';
const table = (rows, sc) => rows.length ? '<table>'+HEAD2()+'<tbody>'+sorted(rows).map(r=>srow(r,sc)).join('')+'</tbody></table>' : '<div class="empty">Nothing here.</div>';

const match = (r,q) => !q || r.client.toLowerCase().includes(q) || r.sow.toLowerCase().includes(q) || String(r.id).includes(q);

const GLOSSARY = '<div class="note"><b>Where each number comes from.</b>'+
 '<dl style="margin:8px 0 0"><dt>Sold</dt><dd>Hours on the SOW\\'s own opportunity, reached through <code>custentity_bpc_primaryopportunity</code> on the project, with duplicated lines collapsed. Blank when the won opportunity has no line items  NetSuite simply does not hold the figure, and it is never inferred from money.</dd>'+
 '<dt>CO</dt><dd>Won change orders linked to that SOW through <code>custbody_bpc_opp_original_sow</code>. Added on top of Sold, because a real CO adds scope.</dd>'+
 '<dt>Plan</dt><dd><code>projecttask.plannedwork</code> on the root tasks. This is what a PM typed at kickoff  it is the number every other report reads, and it is the one that is wrong most often.</dd>'+
 '<dt>Allocated</dt><dd><code>job.allocatedtime</code>  what the PM has staffed. This is the PMO\\'s EAC view. Above the contract it is an early warning of an overrun, not a mistake.</dd>'+
 '<dt>Used</dt><dd><code>projecttask.actualwork</code> on the root tasks, minus the Non-Billable node. Billable only.</dd>'+
 '<dt>Non-billable</dt><dd>Shown per client for information. It never counts against the budget and is in no total on this page.</dd></dl></div>';

function detail(name) {
  const c = D.clients.find(x => x.name === name);
  if (!c) return '<div class="empty">Client not found.</div>';
  const nb = c.sows.reduce((s,r)=>s+(r.nbUsed||0),0);
  const n = v => Math.round(v * 100) / 100;
  const pT = n(c.sows.reduce((s,r)=>s+(r.plannedTime||0),0));
  const aT = n(c.sows.reduce((s,r)=>s+(r.actualTime||0),0));
  const acts = c.sows.filter(r=>r.tasks.length);
  return '<div class="det-head"><div><h1 class="page">'+esc(c.name)+'</h1>'+
    '<p class="lede" style="margin-bottom:0">'+c.sows.length+' open SOW'+(c.sows.length>1?'s':'')+
      (c.closed.length?' / '+c.closed.length+' closed':'')+' &middot; last time booked '+
      (c.sows.map(r=>r.lastTime).filter(Boolean).sort().pop() || '')+'</p></div>'+
    '<div class="noprint" style="display:flex;gap:8px"><button class="btn" onclick="window.print()">Print / PDF</button>'+
    '<button class="btn" data-back="1">  All clients</button></div></div>'+
    '<div class="split"><span>Delivery - internal only</span></div>'+
    '<div class="note" style="margin-bottom:14px">Planned, actual and staffing are shown per SOW in the table below - they are not added up, because two contracts of the same client are two different agreements.</div>'+
    '<div class="cards" hidden>'+
      // The PM's own question comes first here too: our estimate against our spend. Every card
      // says the NetSuite field it is read from, same as the Portfolio headers.
      card('Planned', f(pT), FLD.planned[0], pT?'info':'', null, 'planned') +
      card('Actual', f(aT), FLD.actual[0], '', null, 'actual') +
      card('Left vs est.', pT?f(n(pT-aT)):'', FLD.leftest[0], pT && aT>pT ? 'alert' : '', null, 'leftest') +
      card('Allocated', f(c.t.alloc), FLD.allocated[0], 'info', null, 'allocated') +
    '</div>'+
    '<div class="split"><span>What the client may see</span></div>'+
    '<div class="cards">'+
      card('Contracted', f(c.t.contracted),
        (c.t.co ? 'SOW ' + f(c.t.contracted - c.t.co) + ' + change orders ' + f(c.t.co) : FLD.contracted[0]),
        '', null, 'contracted') +
      card('Used', f(c.t.used), FLD.booked[0], '', null, 'booked') +
      card('Remaining', f(c.t.remaining), FLD.remaining[0], c.t.remaining<0?'alert':'', null, 'remaining') +
      card('Billed hrs', f(c.t.billed), FLD.billed[0], '', null, 'billed') +
      card('Unbilled hrs', f(c.t.ready), FLD.unbilled[0], c.t.ready>0?'warn':'', null, 'unbilled') +
      card('Invoiced hrs', f(n(c.sows.reduce((a,r)=>a+(r.invHrs||0),0))), 'hours sitting on invoice lines') +
      card('Invoiced', money(n(c.sows.reduce((a,r)=>a+(r.invTotal||0),0))), 'total billed to the client') +
      card('Paid', money(n(c.sows.reduce((a,r)=>a+((r.invTotal||0)-(r.invUnpaid||0)),0))), 'settled') +
      card('Outstanding', money(n(c.sows.reduce((a,r)=>a+(r.invUnpaid||0),0))), FLD.unpaid[0],
        c.sows.reduce((a,r)=>a+(r.invUnpaid||0),0)>0?'alert':'', null, 'unpaid') +
      card('Non-billable', f(nb), FLD.nonbill[0], '', null, 'nonbill') +
    '</div>'+
    (() => {
      const ck = c.sows.flatMap(r => r.checks.map(k => [r, k]));
      const noSold = c.sows.filter(r => r.sold == null);
      const noEst  = c.sows.filter(r => !r.plannedTime);
      const bad = noSold.length, warn = ck.length + noEst.length;
      const tone = bad ? 'alert' : warn ? 'warn' : 'ok';
      const verdict = bad
        ? 'Do not quote these numbers to the client yet'
        : warn ? 'Usable internally, one thing does not line up'
        : 'Every source agrees';
      const why = bad
        ? noSold.length + ' of the ' + c.sows.length + ' open SOWs have no contracted figure in NetSuite at all, so Contracted and Remaining fall back to the project plan. Somebody has to read the signed SOW.'
        : warn ? 'The hours are solid; what disagrees is listed below, and each line is a correction someone has to make in NetSuite.'
        : 'The contract, the project plan, the time records and the invoices all tell the same story for this client.';
      const rows = ck.map(([r, k]) => '<tr><td class="name">' + esc(r.sow) + '</td>' +
          '<td><span class="chip gap">' + esc(k[0]) + '</span></td><td>' + esc(k[1]) + '</td></tr>').join('') +
        noSold.map(r => '<tr><td class="name">' + esc(r.sow) + '</td>' +
          '<td><span class="chip over">no contracted figure</span></td>' +
          '<td>The won opportunity carries no hour lines, so NetSuite does not hold what was sold. ' +
          (r.soldBad ? esc(r.soldBad) + ' ' : '') + 'Fix: load the fee-table lines on the opportunity, or read the signed SOW.</td></tr>').join('') +
        noEst.map(r => '<tr><td class="name">' + esc(r.sow) + '</td>' +
          '<td><span class="chip gap">no estimate loaded</span></td>' +
          '<td>No planned time entries exist, so there is nothing to compare the actual hours against.</td></tr>').join('');
      D._notLineUp = rows;
      return '<div class="split"><span>Can these numbers be trusted?</span></div>' +
        '<div class="trust ' + tone + '"><div class="tv">' + verdict + '</div><p>' + why + '</p>' +
        '<div class="tf">Checked: <code>opportunity item quantity</code> against <code>projecttask.plannedwork</code>, ' +
        '<code>timebill.hours timetype A</code> against <code>projecttask.actualwork</code>, ' +
        '<code>timebill.hours timetype P</code> against the plan, <code>job.allocatedtime</code> against its own ' +
        '<code>timetype B</code> rows, and every won <code>custbody_bpc_opp_original_sow</code> change order.' +
        (rows ? ' The detail is at the foot of this page.' : '') + '</div></div>';
    })() +
    sect('SOWs', '<table class="grid"><thead><tr><th>SOW</th>' +
      '<th class="num">Plan</th><th class="num">Allocated</th><th class="num">Used</th>' +
      '<th class="num">Non-bill.</th><th>Used vs plan</th><th>State</th></tr></thead><tbody>' +
      c.sows.map(r => '<tr' + (r.issues.includes('over') ? ' class="is-over"' : '') + '>' +
        '<td class="name">' + esc(r.sow) + '<span class="meta">NS ' + r.id +
          (r.start ? ' &middot; from ' + r.start : '') + (r.lastTime ? ' &middot; last time ' + r.lastTime : '') + '</span>' +
        // What each change order added, on the SOW it was added to - and struck through when it
        // was left out because it restates the contract instead of extending it.
        (r.cos.length ? '<span class="cos">' + r.cos.map(c =>
          '<a class="co' + (r.coNote ? ' out' : '') + '" href="' + OPP(c.id) + '" target="_blank" rel="noopener" title="' +
          esc(r.coNote ? 'Not counted. ' + r.coNote : 'Adds ' + f(c.hrs) + ' hrs on top of the SOW') + '">' +
          esc(c.tranid) + ' +' + f(c.hrs) + 'h</a>').join('') + '</span>' : '') +
        refs(r) + '</td>' +
        '<td class="num muted"><a class="nl" href="' + JOB(r.id) + '" target="_blank" rel="noopener" title="projecttask.plannedwork">' + f(r.plan) + '</a></td>' +
        '<td class="num muted">' + (r.rtm ? '<a class="nl" href="' + RTM(r.rtm) + '" target="_blank" rel="noopener" title="job.allocatedtime - open RTM ' + r.rtm + '">' + f(r.alloc) + '</a>' : f(r.alloc)) + '</td>' +
        '<td class="num strong"><a class="nl" href="' + JOB(r.id) + '" target="_blank" rel="noopener" title="projecttask.actualwork">' + f(r.used) + '</a></td>' +
        '<td class="num nb">' + (r.nbUsed ? f(r.nbUsed) : '') + '</td>' +
        '<td class="pct">' + (r.planPct == null ? '' : r.planPct + '%') + bar(r.planPct) + '</td>' +
        '<td><span class="chip ok">open</span>' + chips(r) + '</td></tr>').join('') +
      c.closed.map(x => '<tr class="cl-row"><td class="name">' + esc(x.sow) +
        '<span class="meta">NS ' + x.id + (x.start ? ' &middot; from ' + x.start : '') + (x.end ? ' &middot; to ' + x.end : '') + '</span>' +
        '<span class="refs noprint">' + (x.opp ? '<a class="lnk" href="' + OPP(x.opp) + '" target="_blank" rel="noopener">opportunity</a>' : '') +
          (x.rtm ? '<a class="lnk" href="' + RTM(x.rtm) + '" target="_blank" rel="noopener">rtm</a>' : '') +
          (x.link ? '<a class="lnk" href="' + x.link + '" target="_blank" rel="noopener">signed sow</a>' : '') + '</span></td>' +
        '<td class="num muted">' + f(x.plan) + '</td><td class="num muted"></td>' +
        '<td class="num">' + f(x.used) + '</td><td class="num nb"></td>' +
        '<td class="pct">' + (x.pct == null ? '' : x.pct + '%') + bar(x.pct) + '</td>' +
        '<td><span class="chip gap">' + (ST[x.st] || x.st) + '</span>' + (x.over ? '<span class="chip over">closed over plan</span>' : '') + '</td></tr>').join('') +
      '</tbody></table>',
      (c.sows.some(r=>r.rtmSaved) ? '<div class="wsub" style="padding:14px 18px 0">What the RTM holds<span class="wx">stored values, not live - the date is when the record was last written</span></div>' +
       '<table class="grid" style="margin:6px 18px 16px;width:auto"><thead><tr><th>SOW</th><th>Saved</th>' +
       '<th class="num">RTM actual</th><th class="num">Live actual</th><th class="num">Gap</th>' +
       '<th class="num">RTM allocated</th><th class="num">Live allocated</th><th class="num">Contract $</th></tr></thead><tbody>' +
       c.sows.filter(r=>r.rtmSaved).map(r => {
         const ga = r.rtmActualHrs != null ? Math.round((r.actualTime - r.rtmActualHrs) * 100) / 100 : null;
         return '<tr><td class="name">' + esc(r.sow.split(' / ').slice(1).join(' / ')) + '</td>' +
         '<td class="muted">' + (r.rtm ? '<a class="nl" href="' + RTM(r.rtm) + '" target="_blank" rel="noopener">' + esc(r.rtmSaved) + '</a>' : esc(r.rtmSaved)) + '</td>' +
         '<td class="num muted">' + f(r.rtmActualHrs) + '</td><td class="num strong">' + f(r.actualTime) + '</td>' +
         '<td class="num' + (Math.abs(ga||0) > 0.5 ? ' neg' : '') + '">' + (ga == null ? '' : (ga > 0 ? '+' : '') + f(ga)) + '</td>' +
         '<td class="num muted">' + f(r.rtmAllocHrs) + '</td><td class="num">' + f(r.alloc) + '</td>' +
         '<td class="num">' + money(r.cwOpp) + '</td></tr>'; }).join('') + '</tbody></table>' +
       '<div class="note" style="margin:0 18px 16px">The RTM keeps its own copy of these figures and nothing refreshes it automatically - verified on 12-Aug-2026. Example Client had five time entries created after its save date and the stored number never moved; a second project sat at 391.5 hrs while 149 approved hours piled up, and 391.5 + 149 is exactly the 540.5 the project shows now. A gap here is not a data error, it is a snapshot waiting for <b>Store Values</b>.</div>' : '') +
      'Open and closed in one list, newest work first. A closed SOW that ran over its plan is the cheapest lesson available for the next one, so it stays visible instead of living in its own table. <b>Used vs plan</b> runs against the project plan, never against the contract or against money.') +
    sect('Work and invoicing', c.sows.map(r => {
      const paid = r.invs.filter(i => !i.unpaid).length;
      const peo = r.who.reduce((a, w) => a + w[1], 0);
      if (!r.invs.length && !r.who.length && !r.tasks.length) return '';
      return '<div class="wblk">' +
        '<div class="wh">' + esc(r.sow) +
          '<span class="meta">' + f(r.used) + ' billable hrs' +
          (r.invs.length ? ' &middot; ' + r.invs.length + ' invoices &middot; ' + f(r.invHrs) + ' hrs invoiced &middot; ' +
            money(r.invTotal) + ' billed &middot; ' + money(n(r.invTotal - r.invUnpaid)) + ' paid' +
            (r.invUnpaid > 0 ? ' &middot; ' + money(r.invUnpaid) + ' outstanding' : '') : '') +
          (r.who.length ? ' &middot; ' + r.who.length + ' people' : '') + '</span></div>' +

        (r.invs.length ? '<div class="wsub">Invoices</div>' +
          '<table class="grid"><thead><tr><th>Invoice</th><th>Date</th><th class="num">Hours</th>' +
          '<th class="num">Amount</th><th class="num">Unpaid</th><th>What it is</th></tr></thead><tbody>' +
          r.invs.map(i => '<tr><td><a class="nl" href="' + INV(i.no) + '" target="_blank" rel="noopener" title="Open this invoice in NetSuite">' + esc(i.no) + '</a></td>' +
            '<td class="muted">' + i.date + '</td><td class="num">' + (i.hrs == null ? '' : f(i.hrs)) + '</td>' +
            '<td class="num">' + (i.amt ? money(i.amt) : '0') + '</td>' +
            '<td class="num' + (i.unpaid > 0 ? ' neg' : '') + '">' + (i.unpaid > 0 ? money(i.unpaid) : '') + '</td>' +
            '<td class="muted">' + (i.hrs == null && i.amt > 0 ? 'deposit or fixed block, no time on it'
              : (i.amt === 0 && i.hrs ? 'time drawn against a block invoiced up front'
              : (i.unpaid > 0 ? 'open' : 'paid'))) + '</td></tr>').join('') +
          '<tr class="total-row"><td><b>Total</b></td><td></td><td class="num strong">' + f(r.invHrs) + '</td>' +
          '<td class="num strong">' + money(r.invTotal) + '</td>' +
          '<td class="num' + (r.invUnpaid > 0 ? ' neg' : '') + '">' + (r.invUnpaid > 0 ? money(r.invUnpaid) : '') + '</td>' +
          '<td class="muted">' + money(n(r.invTotal - r.invUnpaid)) + ' paid</td></tr>' +
          '</tbody></table>' : '') +

        (r.who.length ? '<div class="wsub">Who did the work<span class="wx">all time to date</span></div>' +
          '<table class="grid"><thead><tr><th>Consultant</th><th class="num">Hours</th><th class="num">Share</th>' +
          '<th class="num">Last entry</th></tr></thead><tbody>' +
          r.who.map(w => '<tr><td>' + esc(w[0]) + '</td><td class="num strong">' + f(w[1]) + '</td>' +
            '<td class="num muted">' + (peo ? Math.round(w[1] / peo * 100) : 0) + '%</td>' +
            '<td class="num muted">' + esc(w[2]) + '</td></tr>').join('') + '</tbody></table>' : '') +

        (r.tasks.length ? '<div class="wsub">What they worked on<span class="wx">last 60 days &middot; ' +
            f(r.h30) + ' hrs in 30d</span></div>' +
          '<table class="grid"><thead><tr><th>Task</th><th class="num">Hours</th><th class="num">Last entry</th></tr></thead><tbody>' +
          r.tasks.map(t => '<tr><td>' + esc(t[0]) +
            (/^non-billable/i.test(t[0]) ? ' <span class="chip gap">not against the budget</span>' : '') +
            (/^co\s*\d|^co\d/i.test(t[0]) ? ' <span class="chip ok">change order</span>' : '') + '</td>' +
            '<td class="num strong">' + f(t[1]) + '</td><td class="num muted">' + esc(t[2]) + '</td></tr>').join('') +
          '</tbody></table>' : '') +
      '</div>'; }).join(''),
      'Everything about the delivered work in one place: what went out on an invoice, who did the hours, and what they were booked against. <b>Hours</b> on an invoice is the time attached to it - blank means the invoice carries no time at all, a deposit or a monthly block. An amount of zero with hours on it is time drawn against a block invoiced up front. The people and the tasks come from <code>timebill</code> with <code>timetype = A</code>, so planned and allocation rows cannot inflate them. <b>Which invoice paid for which person is not linked yet</b> - that needs a per-charge pull and is coming from a script, not from this page.') +

    (D._notLineUp ? sect('Everything that does not reconcile',
      '<table class="grid"><thead><tr><th>SOW</th><th>What disagrees</th><th>Detail</th></tr></thead><tbody>' + D._notLineUp + '</tbody></table>',
      'Every source that contradicts another one for this client, in one place. None of it is guessed around - both numbers are shown and the fields are named. Each line is a correction somebody has to make in NetSuite.') : '') +
    '<div class="printonly" style="margin-top:16px;font-size:10pt;color:#767676">Example Client &middot; hours as recorded in NetSuite on '+D.runDate+'.</div>';
}

/* ---- charts -------------------------------------------------------------------------
   Two forms only, both magnitude jobs, both single-series so no legend is needed:
   a bucket strip and horizontal bars. Colour is doing a STATUS job (on track / running
   low / over), so every band also carries its own text label  identity is never
   colour-alone. Marks are thin with 4px rounded data-ends anchored to the baseline,
   values sit in ink tokens rather than the series colour, and the axis is recessive. */
const CH = { ok:'#619C8A', low:'#F2CC5F', over:'#C9512E', neutral:'#334E55', grid:'#EEE' };

function hbars(items, opt) {
  // items: [{label, value, sub, tone, href}]
  if (!items.length) return '<div class="empty">Nothing to plot.</div>';
  const max = Math.max(...items.map(i => i.value), 1);
  const fmtv = opt && opt.fmt ? opt.fmt : (v => f(v));
  return '<div class="chart">' + items.map(i => {
    const w = Math.max(1.5, (i.value / max) * 100);
    return '<div class="hbar">' +
      '<div class="hb-l" title="' + esc(i.label) + '">' + (i.client
        ? '<button class="t" data-client="' + esc(i.client) + '">' + esc(i.label) + '</button>'
        : esc(i.label)) + (i.sub ? '<span class="hb-s">' + esc(i.sub) + '</span>' : '') + '</div>' +
      '<div class="hb-t"><span class="hb-f" style="width:' + w + '%;background:' + (CH[i.tone] || CH.neutral) + '"></span></div>' +
      '<div class="hb-v">' + fmtv(i.value) + '</div></div>';
  }).join('') + '</div>';
}

function buckets(rs) {
  // Distribution of consumption. Status encoding, so each band is labelled in words --
  // and each band is a button: the number is only useful if you can see who is in it.
  const b = [
    { id:'u50',  k: 'Under 50%', tone: 'ok',   n: rs.filter(r => r.pct != null && r.pct < 50).length },
    { id:'u85',  k: '50-84%',    tone: 'ok',   n: rs.filter(r => r.pct >= 50 && r.pct < 85).length },
    { id:'u100', k: '85-100%',   tone: 'low',  n: rs.filter(r => r.pct >= 85 && r.pct <= 100).length },
    { id:'over', k: 'Over 100%', tone: 'over', n: rs.filter(r => r.pct > 100).length },
    { id:'none', k: 'No figure', tone: 'neutral', n: rs.filter(r => r.pct == null).length },
  ].filter(x => x.n);
  const tot = b.reduce((s, x) => s + x.n, 0) || 1;
  return '<div class="strip">' + b.map(x =>
    '<button class="sg" data-band="' + x.id + '" title="Show these ' + x.n + ' SOWs">' +
    '<div class="sb" style="background:' + CH[x.tone] + '"></div>' +
    '<div class="sl"><b>' + x.n + '</b> ' + x.k + '</div></button>').join('') +
    '</div><div class="strip-foot">' + tot + ' open SOWs by how much of what was bought has been used. Click a band to list them.</div>';
}

const BAND = {
  u50:  { label: 'Under 50% used',   test: r => r.pct != null && r.pct < 50 },
  u85:  { label: '50-84% used',      test: r => r.pct >= 50 && r.pct < 85 },
  u100: { label: '85-100% used',     test: r => r.pct >= 85 && r.pct <= 100 },
  over: { label: 'Over 100% used',   test: r => r.pct > 100 },
  none: { label: 'No consumption figure', test: r => r.pct == null },
};


/* Every number on this site, its NetSuite field and one line on what it actually is. The
   column header shows the field; hovering shows the sentence. One dictionary, so the tooltip
   and the Help page cannot drift apart. */
const NL = String.fromCharCode(10);
const FLD = {
  planned:   ["projecttask.plannedwork", "The project plan on the root tasks - the same figure the RTM calls Planned Hours. Every SOW has one, which is why the sheet uses it. The PMO also loads planned time entries (timetype P); where the two disagree it is listed under Checks."],
  actual:    ["timebill.hours where isbillable = T", "Billable time logged against the project, taken from the flag on each time entry rather than from a task named Non-Billable. That task does not exist on every project and the plan only updates once time is approved, so the flag is the one thing that cannot drift. Non-billable sits in its own column and counts against nothing."],
  leftest:   ["plannedwork - billable actual", "How much of our own estimate is left. Negative means the work took longer than we said. Internal: the client never agreed to this estimate, only to a scope and a total."],
  ofest:     ["billable actual / plannedwork", "How much of the estimate has been spent. Over 100% means past our own forecast, which is not the same as past the contract."],
  allocated: ["job.allocatedtime", "Everything the PM has staffed, running forward to the end of the plan. Equals the sum of resourceallocation.numberhours and is generated from the RTM. Above the contract it is an early warning, not an overrun."],
  booked:    ["projecttask.actualwork", "Hours on the root project tasks, minus the Non-Billable node. Same work as Actual but read from the project plan instead of the time records - a gap between them is time waiting for approval."],
  contracted:["opportunity item quantity + won change orders", "What the client bought: the hour lines on the SOW opportunity plus the COs that genuinely add scope. A CO that repeats the SOW line for line restates the contract and is excluded."],
  remaining: ["contracted - used", "Hours left on the contract. This is the figure a client may be told."],
  consumed:  ["used / contracted", "How much of the contract has been delivered."],
  renewal:   ["custentity_bpc_ms_renewal_date", "Managed Services renewal date. Red once it has passed."],
  billed:    ["charge.stage = BILLED", "Time approved and already on an invoice."],
  unbilled:  ["charge.stage = READY_FOR_BILLING", "Time approved and waiting to be invoiced - delivered work not yet charged for."],
  unpaid:    ["transaction.foreignamountunpaid", "Invoiced and still outstanding. If one invoice spans two projects this is the whole invoice."],
  nonbill:   ["timebill.hours where isbillable = F", "Shown because it exists. It is not part of Used and it is in no total on this page."],
  sold:      ["opportunity item quantity", "Hours on the SOW opportunity, reached through custentity_bpc_primaryopportunity. Blank when the won opportunity carries no line items - NetSuite does not hold the figure, and it is never inferred from money."],
  co:        ["custbody_bpc_opp_original_sow", "Won change orders pointing at this project. Counted only when they add scope."],
  plan:      ["projecttask.plannedwork", "What a PM typed into the plan at kickoff. The number most other reports read, and the one that is wrong most often."],
  checks:    ["computed here", "Two NetSuite fields that ought to say the same thing and do not. Each one is a correction somebody has to make in NetSuite."],
  status:    ["computed here", "Worst flag across the SOWs of this client: over budget, term ended, 85% or more, renewing, no signed figure, or quiet."],
  client:    ["job.companyname", "The NetSuite project name, cut at the first pipe."],
};
const card = (k,v,s,cls,goto,fk) => '<div class="card '+(cls||'')+(goto?' click':'')+'"'+(goto?' data-goto="'+goto+'"':'')+
  (fk&&FLD[fk]?' title="'+esc('[ '+FLD[fk][0]+' ]' + NL + NL + FLD[fk][1])+'"':'')+
  '><div class="k">'+k+'</div><div class="v">'+v+'</div>'+(s?'<div class="s">'+s+'</div>':'')+'</div>';
const sect = (title, body, sub, extra) => '<div class="section"><div class="section-head"><h2>'+title+'</h2>'+
  (extra?'<div class="tot">'+extra+'</div>':'')+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+body+'</div>';

function invoicesView(q) {
  const n = v => Math.round(v * 100) / 100;
  // Every invoice on every open SOW, one flat list, grouped by client and SOW. Paid and
  // unpaid together: the question a PM actually asks is "did this go out and did it land",
  // and splitting them into two screens makes that two lookups instead of one.
  const rs = D.rows.filter(r => match(r, q) && r.invs.length);
  const all = rs.flatMap(r => r.invs.map(i => ({...i, client: r.client, sow: r.sow, id: r.id})));
  if (!all.length) return '<div class="empty">No invoices match.</div>';
  const tot = n(all.reduce((s,i)=>s+(i.amt||0),0)), unp = n(all.reduce((s,i)=>s+(i.unpaid||0),0));
  const hrs = n(all.reduce((s,i)=>s+(i.hrs||0),0));
  const open = all.filter(i=>i.unpaid>0);
  const byClient = [...rs.reduce((m,r)=>(m.get(r.client)?m.get(r.client).push(r):m.set(r.client,[r]),m),new Map())]
    .sort((a,b)=>a[0].localeCompare(b[0]));
  return '<h1 class="page">Invoices</h1><p class="lede">Every invoice that carries a line for an open SOW, paid and unpaid together, grouped by client and SOW. Hours are the time attached to that invoice; blank means it carries no time at all - a deposit, a monthly block or a fixed fee.</p>'+
    '<div class="cards">'+ card('Invoices', String(all.length)) + card('Hours billed', f(hrs)) +
      card('Invoiced', money(tot)) + card('Still unpaid', money(unp), open.length+' open', unp>0?'alert':'') + '</div>'+
    byClient.map(([name, sows]) => sect(name, sows.map(r=>{
      const paid = r.invs.filter(i=>!i.unpaid).length, ru = n(r.invs.reduce((s,i)=>s+(i.unpaid||0),0));
      return '<div style="padding:12px 18px;border-bottom:1px solid var(--g-100)">'+
      '<div style="font-size:13px;font-weight:500;margin-bottom:6px"><button class="t" data-client="'+esc(name)+'">'+esc(r.sow)+'</button>'+
      '<span class="meta" style="display:inline;margin-left:8px">'+r.invs.length+' invoices &middot; '+f(r.invHrs)+' hrs &middot; '+money(r.invTotal)+
      ' &middot; '+paid+' paid'+(ru>0?' &middot; '+money(ru)+' open':'')+'</span></div>'+
      '<table style="font-size:12.5px"><thead><tr><th>Invoice</th><th>Date</th><th class="num">Hours</th><th class="num">Amount</th><th class="num">Unpaid</th><th>Status</th></tr></thead><tbody>'+
      r.invs.map(i=>'<tr><td><a class="nl" href="'+INV(i.no)+'" target="_blank" rel="noopener" title="Open this invoice in NetSuite">'+esc(i.no)+'</a></td><td class="muted">'+i.date+'</td>'+
        '<td class="num">'+(i.hrs==null?'':f(i.hrs))+'</td><td class="num">'+(i.amt?money(i.amt):'0')+'</td>'+
        '<td class="num'+(i.unpaid>0?' neg':'')+'">'+(i.unpaid>0?money(i.unpaid):'')+'</td>'+
        '<td><span class="chip '+(i.unpaid>0?'gap':'ok')+'">'+(i.unpaid>0?'unpaid':'paid')+'</span>'+
        (i.hrs==null&&i.amt>0?' <span class="chip gap">no time on it</span>':'')+
        (i.amt===0&&i.hrs?' <span class="chip gap">drawn against a prepaid block</span>':'')+'</td></tr>').join('')+
      '</tbody></table></div>'; }).join(''))).join('');
}

function pvaView(q) {
  const n = v => Math.round(v * 100) / 100;
  // The delivery question, and the one thing on this site that never goes to a client:
  // what we ESTIMATED against what we SPENT. The client never agreed to our estimate -
  // they agreed to a scope and a total - so showing them this invites an argument about
  // hours they have already paid for.
  const rs = D.rows.filter(r => match(r, q));
  const have = rs.filter(r => r.plannedTime > 0).sort((a,b)=>(b.pvaGap||0)-(a.pvaGap||0));
  const none = rs.filter(r => !r.plannedTime);
  const over = have.filter(r=>r.pvaGap > 0);
  const row = r => '<tr'+(r.pvaGap>0?' class="is-over"':'')+'><td class="name"><button class="t" data-client="'+esc(r.client)+'">'+esc(r.sow)+'</button>'+
    '<span class="meta">NS '+r.id+'</span></td>'+
    '<td class="num muted">'+f(r.plannedTime)+'</td><td class="num strong">'+f(r.actualTime)+'</td>'+
    '<td class="num'+(r.pvaGap>0?' neg':'')+'">'+(r.pvaGap>0?'+':'')+f(r.pvaGap)+'</td>'+
    '<td class="num">'+(r.pvaPct==null?'':r.pvaPct+'%')+'</td>'+
    '<td class="num muted">'+f(r.allocTime)+'</td></tr>';
  return '<h1 class="page">Planned vs actual</h1>'+
    '<p class="lede"><b>Internal only.</b> What we estimated against what we spent, per SOW. This is the delivery view - the client never agreed to our estimate, only to a scope and a total, so none of this is shown to them. For what a client sees, use Portfolio and Invoices.</p>'+
    '<div class="cards">'+ card('SOWs with an estimate', String(have.length), 'of '+rs.length) +
      card('Over the estimate', String(over.length), '', over.length?'alert':'') +
      card('Hours over', f(n(over.reduce((s,r)=>s+r.pvaGap,0))), '', over.length?'alert':'') +
      card('No estimate loaded', String(none.length), 'cannot be compared', none.length?'warn':'') + '</div>'+
    sect('Every SOW with a planned-time estimate',
      '<table><thead><tr><th>Client / SOW</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Gap</th><th class="num">Of estimate</th><th class="num">From allocation</th></tr></thead><tbody>'+
      have.map(row).join('')+'</tbody></table>',
      'Sorted by how far past the estimate the project has gone. <b>Planned</b> is <code>timetype = P</code>, the planned time entries the PMO forecasts with. <b>Actual</b> is <code>timetype = A</code>. <b>From allocation</b> is <code>timetype = B</code>, generated from the resource allocation - a separate forecast, shown so you can see when the two disagree.') +
    (none.length ? sect('No planned time entries', '<table><thead><tr><th>Client / SOW</th><th class="num">Actual</th><th class="num">From allocation</th></tr></thead><tbody>'+
      none.map(r=>'<tr><td class="name"><button class="t" data-client="'+esc(r.client)+'">'+esc(r.sow)+'</button></td>'+
      '<td class="num strong">'+f(r.actualTime)+'</td><td class="num muted">'+f(r.allocTime)+'</td></tr>').join('')+'</tbody></table>',
      'These projects have actual time but no planned time entries, so there is nothing to compare against. Either the PMO never loaded the forecast, or this project is not run that way.') : '')+
    '<div class="note"><b>Where this comes from.</b> One query, no export and no pivot: <code>timebill</code> grouped by project, task and employee, split on <code>timetype</code>. It reproduces the EAC workbook <i>the EAC workbook</i> exactly - reproduced to the decimal against the workbook. The equivalent saved searches are <code>CUSTOMSEARCH_BPC_PROJ_TASKS_PLANNED_ACTU</code> (tasks over plan, with PM and EM) and <code>CUSTOMSEARCH_BPC_RESOURCE_ALLOCATIONS_TA</code> (allocation per person with the task).</div>';
}

const VIEWS = {
  invoices: invoicesView,
  pva: pvaView,
  portfolio(q) {
    const rs = D.rows.filter(r => match(r, q));
    rs.forEach(r => { r._left = r.plan ? Math.round((r.plan - r.used) * 100) / 100 : null;
                      r._pct  = r.plan ? Math.round(r.used / r.plan * 100) : null; });
    const SORTF = { client:(a,b)=>(a.client+a.sow).localeCompare(b.client+b.sow),
                    sow:(a,b)=>a.sow.localeCompare(b.sow),
                    status:(a,b)=>(b.issues.length-a.issues.length),
                    checks:(a,b)=>(b.checks.length-a.checks.length) };
    rs.sort((a, b) => {
      if (SORTF[psort]) return SORTF[psort](a, b) * pdir;
      const k = { planned:'plan', actual:'used', leftest:'_left', ofest:'_pct', allocated:'alloc', nonbill:'nbUsed' }[psort];
      if (!k) return (a.client + a.sow).localeCompare(b.client + b.sow);
      const x = a[k], y = b[k];
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (x - y) * pdir;
    });
    const NLx = String.fromCharCode(10);
    const tip = k => { const d = FLD[k]; return d ? esc('[ ' + d[0] + ' ]' + NLx + NLx + d[1]) : ''; };
    // The header carries a short field tag; the full field name and the sentence live in the
    // tooltip. Long mono strings in a <th> wrapped to three lines and made the sheet unreadable.
    const SHORT = { planned:'timetype P', actual:'timetype A', leftest:'planned - actual',
      ofest:'actual / planned', allocated:'allocatedtime', booked:'actualwork',
      status:'computed', checks:'computed', client:'companyname' };
    const SK = { planned:'plan', actual:'used', leftest:'_left', ofest:'_pct', allocated:'alloc', nonbill:'nbUsed' };
    const ar = k => psort === k
      ? '<span class="sa on">' + (pdir < 0 ? '&#9660;' : '&#9650;') + '</span>'
      : '<span class="sa">&#8645;</span>';
    const th = (t, k) => '<th class="num" title="' + tip(k) + '">' +
      '<button class="sortb" data-ps="' + k + '">' + t + ar(k) + '</button>' +
      '<div class="fld">' + esc(SHORT[k] || '') + '</div></th>';

    const est = r => (r.plannedTime ? Math.round(r.actualTime / r.plannedTime * 100) : null);
    const LIVE = { 17: 'on hold', 28: 'accounting review' };  // st 1 = Complete, 4 = Closed
    const hit = x => !q || x.client.toLowerCase().includes(q) || x.sow.toLowerCase().includes(q) || String(x.id).includes(q);
    const wind = D.closed.filter(x => LIVE[x.st] && hit(x));
    const done = D.closed.filter(x => !LIVE[x.st] && hit(x));

    // Tick as many as you like. The states decide which SOWs are in the list; the flags narrow
    // it, and several flags read as OR - "show me anything past our estimate OR gone quiet".
    const ST_OPTS = [['open', 'Open', () => rs.length], ['hold', 'On hold or in accounting review', () => wind.length],
                     ['done', 'Finished', () => done.length]];
    const FL = {
      overest:  [r => r.plan && r.used > r.plan, 'Past the plan'],
      noplantime: [r => !r.plannedTime, 'No planned time entries loaded'],
      overstaff:[r => r.plan && r.alloc > r.plan * 1.05, 'Staffed above the plan'],
      noplan:   [r => !r.plan, 'No project plan at all'],
      mismatch: [r => r.checks.length, 'NetSuite contradicts itself'],
      quiet:    [r => r.issues.includes('stale'), 'No time booked in 45 days'],
      renew:    [r => r.issues.includes('renewing') || r.issues.includes('expired'), 'Renewing or already ended'],
    };
    const on = [...flags];
    const pass = r => !on.length || on.some(k => FL[k][0](r));
    const shown      = state.has('open') ? rs.filter(pass) : [];
    const winding    = state.has('hold') && !on.length ? wind : [];
    const closedRows = state.has('done') && !on.length ? done : [];

    const total = shown.length + winding.length + closedRows.length;
    const label = on.length
      ? on.map(k => FL[k][1]).join(' or ')
      : state.size === 3 ? 'Everything' : ST_OPTS.filter(o => state.has(o[0])).map(o => o[1]).join(' and ');
    const chips = '<div class="dd' + (ddOpen ? ' open' : '') + '">' +
      '<button class="ddb" id="ddb"><span class="fl">View</span>' + esc(label) +
        ' <span class="fn">' + total + '</span><span class="cv"></span></button>' +
      '<div class="ddp">' +
        '<div class="ddh">Include</div>' +
        ST_OPTS.map(([k, lbl, n]) => '<label class="ddi"><input type="checkbox" data-st="' + k + '"' +
          (state.has(k) ? ' checked' : '') + '><span>' + lbl + '</span><b>' + n() + '</b></label>').join('') +
        '<div class="ddh">Only show SOWs that are<span class="ddx">any ticked box matches</span></div>' +
        Object.keys(FL).map(k => '<label class="ddi"><input type="checkbox" data-fl="' + k + '"' +
          (flags.has(k) ? ' checked' : '') + '><span>' + FL[k][1] + '</span><b>' + rs.filter(FL[k][0]).length + '</b></label>').join('') +
        (on.length ? '<button class="ddclear" data-clear="1">Clear the flags</button>' : '') +
      '</div></div>';

    const stat = r => r.issues.includes('over') ? '<span class="chip over">over budget</span>'
      : r.issues.includes('expired') ? '<span class="chip over">term ended</span>'
      : r.issues.includes('low') ? '<span class="chip warn">85%+</span>'
      : r.issues.includes('renewing') ? '<span class="chip warn">renewing</span>'
      : r.sold == null ? '<span class="chip gap">no signed figure</span>'
      : r.issues.includes('stale') ? '<span class="chip gap">quiet</span>'
      : '<span class="chip ok">on track</span>';

    return '<h1 class="page">Portfolio</h1>' +
      '<div class="fbar noprint">' + chips + '</div>' +
      '<p class="lede"><b>' + (shown.length + winding.length + closedRows.length) + ' SOWs</b> - ' +
      shown.length + ' open' + (winding.length ? ', ' + winding.length + ' on hold or in accounting review' : '') +
      (closedRows.length ? ', ' + closedRows.length + ' finished' : '') + '. <b>One row per SOW, never a client total</b> - a client with two contracts gets two rows, because hours belong to a contract and do not add up across them. <b>This sheet is the delivery view</b>: what we estimated against what we spent, the same figures as the EAC workbook <i>the EAC workbook</i>, and internal. Click a name for the contract, the invoicing and everything a client may see. Click any heading to sort by it, click again to reverse. Hover a heading for the NetSuite field behind it.</p>' +
      '<table class="grid"><thead><tr>' +
      '<th title="' + tip('client') + '"><button class="sortb" data-ps="client">Client' + ar('client') + '</button><div class="fld">companyname</div></th>' +
      '<th><button class="sortb" data-ps="sow">SOW' + ar('sow') + '</button><div class="fld">job / contract</div></th>' +
      th('Planned', 'planned') + th('Actual', 'actual') + th('Left on plan', 'leftest') +
      th('Of plan', 'ofest') + th('Allocated', 'allocated') + th('Non-bill.', 'nonbill') +
      '<th title="' + tip('status') + '"><button class="sortb" data-ps="status">Status' + ar('status') + '</button></th>' +
      '<th title="' + tip('checks') + '"><button class="sortb" data-ps="checks">Checks' + ar('checks') + '</button></th></tr></thead><tbody>' +
      shown.map(r => {
        // Billable actual, the way the RTM reports it - non-billable time never counted
        // against a budget and must not count against an estimate either.
        const act = r.used, pl = r.plan,
          e = pl ? Math.round(act / pl * 100) : null,
          left = pl ? Math.round((pl - act) * 100) / 100 : null;
        return '<tr' + (r.issues.includes('over') ? ' class="is-over"' : '') + '>' +
        '<td class="cl"><button class="t" data-client="' + esc(r.client) + '">' + esc(r.client) + '</button></td>' +
        '<td class="sw"><span class="swn">' + esc(r.sow.split(' / ').slice(1).join(' / ') || r.sow) + '</span>' +
        // The change orders are folded into the contract automatically, which made them
        // invisible. They are named on the row they belong to, with a note when one was left out.
        (r.cos.length ? '<span class="cos">' + r.cos.map(c =>
          '<a class="co' + (r.coNote ? ' out' : '') + '" href="' + OPP(c.id) + '" target="_blank" rel="noopener" title="' +
          esc(r.coNote ? 'Not counted. ' + r.coNote : 'Counted on top of the SOW') + '">' +
          esc(c.tranid) + ' ' + f(c.hrs) + 'h</a>').join('') + '</span>' : '') +
        '<span class="meta">NS ' + r.id + (r.renewal ? ' &middot; renews ' + esc(r.renewal) : '') +
          (r.lastTime ? ' &middot; last ' + esc(r.lastTime) : '') + '</span></td>' +
        // Both figures are forecast and burn against the same RTM, so the number is the link.
        '<td class="num muted">' + (pl
          ? (r.rtm ? '<a class="nl" href="' + RTM(r.rtm) + '" target="_blank" rel="noopener" title="projecttask.plannedwork - open RTM ' + r.rtm + '">' + f(pl) + '</a>' : f(pl))
          : '<span class="muted">no plan</span>') + '</td>' +
        '<td class="num strong">' + (r.rtm
          ? '<a class="nl" href="' + RTM(r.rtm) + '" target="_blank" rel="noopener" title="Open RTM ' + r.rtm + '">' + f(act) + '</a>'
          : f(act)) + '</td>' +
        '<td class="num' + (left < 0 ? ' neg' : '') + '">' + (left == null ? '' : f(left)) + '</td>' +
        '<td class="num' + (e > 100 ? ' neg' : '') + '" style="white-space:nowrap">' + (e == null ? '' : e + '% ' + bar(e)) + '</td>' +
        '<td class="num muted">' + f(r.alloc) + '</td>' +
        '<td class="num nb">' + (r.nbUsed ? f(r.nbUsed) : '') + '</td>' +
        '<td>' + stat(r) + '</td>' +
        '<td>' + (r.checks.length
          ? '<span class="chip gap" title="' + esc(r.checks.map(k => k[0] + ': ' + k[1]).join(NLx + NLx)) + '">' +
            r.checks.length + ' to fix' + '</span>'
          : '<span class="chip ok">consistent</span>') + '</td></tr>';
      }).join('') +
      (winding.map(x => '<tr class="cl-row">' +
        '<td class="cl"><button class="t" data-client="' + esc(x.client) + '">' + esc(x.client) + '</button></td>' +
        '<td class="sw"><span class="swn">' + esc(x.sow.split(' / ').slice(1).join(' / ') || x.sow) + '</span></td>' +
        '<td class="num muted">' + f(x.plan) + '</td>' +
        '<td class="num strong">' + f(x.used) + '</td>' +
        '<td class="num' + (x.plan && x.used > x.plan ? ' neg' : '') + '">' + (x.plan ? f(Math.round((x.plan - x.used) * 100) / 100) : '') + '</td>' +
        '<td class="num' + (x.pct > 100 ? ' neg' : '') + '">' + (x.pct == null ? '' : x.pct + '% ' + bar(x.pct)) + '</td>' +
        '<td class="num muted"></td><td class="num nb"></td>' +
        '<td><span class="chip warn">' + esc(LIVE[x.st]) + '</span>' + (x.over ? '<span class="chip over">over plan</span>' : '') + '</td>' +
        '<td><span class="chip ok">consistent</span></td></tr>').join('')) +
      (closedRows.map(x => '<tr class="cl-row">' +
        '<td class="cl"><button class="t" data-client="' + esc(x.client) + '">' + esc(x.client) + '</button></td>' +
        '<td class="sw"><span class="swn">' + esc(x.sow.split(' / ').slice(1).join(' / ') || x.sow) + '</span></td>' +
        '<td class="num muted">' + f(x.plan) + '</td>' +
        '<td class="num strong">' + f(x.used) + '</td>' +
        '<td class="num' + (x.plan && x.used > x.plan ? ' neg' : '') + '">' + (x.plan ? f(Math.round((x.plan - x.used) * 100) / 100) : '') + '</td>' +
        '<td class="num' + (x.pct > 100 ? ' neg' : '') + '">' + (x.pct == null ? '' : x.pct + '% ' + bar(x.pct)) + '</td>' +
        '<td class="num muted"></td><td class="num nb"></td>' +
        '<td><span class="chip gap">' + esc(ST[x.st] || String(x.st)) + '</span></td>' +
        '<td>' + (x.over ? '<span class="chip over">closed over plan</span>' : '<span class="chip ok">closed</span>') + '</td></tr>').join('')) +
      '</tbody></table>' +
      (closedRows.length ? '<div class="note">Finished SOWs carry no delivery estimate any more, so Planned, Actual and Allocated are blank. What is kept is the plan against what was actually booked - a closed SOW that ran over its plan is the cheapest lesson available for the next one.</div>' : '') +
      '<div class="note"><b>Nothing on this sheet goes to a client.</b> It is our estimate against our spend: the client agreed to a scope and a total, never to our estimate. <b>Planned</b> is blank where no planned time entries were ever loaded - there the comparison cannot be made, and the console says so rather than inventing a baseline. <b>Booked</b> is the same hours as Actual read from the project plan instead of the time records; a gap between them is time waiting for approval. <b>Allocated</b> is forward staffing, so above the contract it is an early warning, not an overrun.</div>';
  },
  attention(q) {
    const rs = D.rows.filter(r=>match(r,q));
    const g = k => rs.filter(r=>r.issues.includes(k));
    return '<h1 class="page">Needs attention</h1><p class="lede">Over what was bought, close to it, staffed beyond the contract, past term, or gone quiet.</p>'+
      sect('Over budget', table(g('over'),true)) +
      sect('At 85% or more', table(g('low'),true)) +
      sect('Staffed above contract', table(g('overstaffed').filter(r=>!r.issues.includes('over')),true),
        'The PM has allocated more hours than the client bought  usually an overrun forecast worth reading early.') +
      sect('No time booked in 45+ days, still open', table(g('stale'),true));
  },
  renewals(q) {
    const rs = D.rows.filter(r=>match(r,q)&&r.ms);
    const exp = rs.filter(r=>r.issues.includes('expired'));
    const soon = rs.filter(r=>r.issues.includes('renewing'));
    const noterm = rs.filter(r=>r.issues.includes('noterm'));
    const rest = rs.filter(r=>!exp.includes(r)&&!soon.includes(r)&&!noterm.includes(r));
    const nice = r => r.autoRenew ? 'Auto-renew ON  30-day notice to stop it' : 'Auto-renew OFF  needs a renewal SOW';
    const tbl = list => list.length ? '<table><thead><tr><th>SOW</th><th>Term ends</th><th>Auto-renew</th><th class="num">Contracted</th><th class="num">Used</th><th class="num">Remaining</th></tr></thead><tbody>'+
      list.map(r=>'<tr'+cls(r)+'><td class="name"><b>'+esc(r.client)+'</b><br><a class="t" href="'+JOB(r.id)+'" target="_blank" rel="noopener">'+esc(r.sow)+'</a>'+
      '<span class="meta">NS '+r.id+(r.rollover===0?' &middot; no rollover  unused hours expire':'')+'</span></td>'+
      '<td>'+(r.renewal||r.end||'')+(r.renewalDays!=null?'<span class="meta">'+(r.renewalDays<0?Math.abs(r.renewalDays)+' days ago':'in '+r.renewalDays+' days')+'</span>':'')+'</td>'+
      '<td><span class="chip '+(r.autoRenew?'ok':'low')+'">'+nice(r)+'</span></td>'+
      '<td class="num">'+f(r.contracted)+'</td><td class="num strong">'+f(r.used)+'</td>'+
      '<td class="num'+(r.remaining<0?' neg':'')+'">'+f(r.remaining)+'</td></tr>').join('')+'</tbody></table>' : '<div class="empty">Nothing here.</div>';
    return '<h1 class="page">Renewals</h1><p class="lede">Every Managed Services SOW and where its term stands. Computed from the contract dates on the project, not from a saved search  so a missing date shows up as a gap instead of disappearing.</p>'+
      sect('Term already ended', tbl(exp), 'If auto-renew is ON the block probably rolled over  confirm. If it is OFF, this SOW is running with no contract behind it.') +
      sect('Renews within 60 days', tbl(soon), 'With auto-renew ON the window to stop it closes 30 days before the date.') +
      sect('No term loaded in NetSuite', tbl(noterm), 'No end date and no renewal date, so nothing can tell you when this ends. PM: load the term.') +
      sect('Everything else', tbl(rest));
  },
  clients(q) {
    const cs = D.clients.map(c=>({...c, sows:c.sows.filter(r=>match(r,q))})).filter(c=>c.sows.length);
    if (!cs.length) return '<h1 class="page">Clients</h1><div class="empty">No client matches that filter.</div>';
    return '<h1 class="page">Clients</h1><p class="lede">'+cs.length+' clients, worst first. Click one for the full picture  hours, invoices, closed SOWs and where the time is landing.</p>'+
      '<div class="clientlist">'+cs.map(c=>{
        const bad = c.sows.filter(r=>r.issues.includes('over')).length, low = c.sows.filter(r=>r.issues.includes('low')).length;
        return '<button class="ccard" data-client="'+esc(c.name)+'"><div class="cn">'+esc(c.name)+'</div>'+
        '<div class="cm"><span>'+f(c.t.contracted)+' contracted</span><span>'+f(c.t.used)+' used</span>'+
        '<span'+(c.t.remaining<0?' style="color:var(--danger)"':'')+'>'+f(c.t.remaining)+' left</span></div>'+
        '<div class="cb">'+bar(c.t.pct)+' <span class="pct">'+(c.t.pct==null?'':c.t.pct+'%')+'</span>'+
        (bad?'<span class="chip over">'+bad+' over</span>':'')+(low?'<span class="chip low">'+low+' low</span>':'')+
        (c.closed.length?'<span class="chip gap">'+c.closed.length+' closed</span>':'')+'</div></button>'; }).join('')+'</div>';
  },
  help() {
    return '<h1 class="page">Help</h1>' +
      '<p class="lede">Every figure on this page, the NetSuite field it is read from, and who keeps it right. ' +
      'Nothing here is estimated and no hours figure is ever derived from money. Where NetSuite holds no answer, ' +
      'the page says so rather than inventing a baseline.</p>' +

      sect('The one rule',
        '<div class="note" style="margin:0;border:0"><b>Read the field, not the label.</b> The same word means four ' +
        'different things in NetSuite depending on which record you open. <i>Planned</i> is what a PM typed, ' +
        '<i>Allocated</i> is who is staffed, <i>Actual</i> is time logged, and <i>Contracted</i> is what was signed. ' +
        'They are not versions of one number, they are four different facts, and they disagree on most projects. ' +
        'That disagreement is the report, not a fault in it.</div>') +

      sect('Where every number comes from',
        '<table class="grid"><thead><tr><th>Column</th><th>NetSuite field</th><th>What it means</th>' +
        '<th>Kept right by</th></tr></thead><tbody><tr><td><b>Planned</b></td><td><code>projecttask.plannedwork</code><span class="meta">root tasks only</span></td><td>What a PM typed into the project plan at kickoff. The same figure the RTM calls Planned Hours. Every SOW has one, which is why the sheet leads with it.</td><td class="muted">The PM, in the project plan.</td></tr><tr><td><b>Actual</b></td><td><code>timebill.hours where isbillable = T</code><span class="meta">timetype = A</span></td><td>Billable time logged against the project, taken from the flag on each time entry. It is not inferred from a task named Non-Billable: that task does not exist everywhere, and the plan only updates once time is approved.</td><td class="muted">Consultants, when they log time.</td></tr><tr><td><b>Left on plan</b></td><td><code>plannedwork - billable actual</code><span class="meta">computed here</span></td><td>How much of the plan is left. Negative means the work has run past what was planned, which is not the same as running past the contract.</td><td class="muted">Nobody - it moves on its own.</td></tr><tr><td><b>Of plan</b></td><td><code>billable actual / plannedwork</code><span class="meta">computed here</span></td><td>How much of the plan has been delivered. Green under 85, amber to 100, red past it.</td><td class="muted">Nobody.</td></tr><tr><td><b>Allocated</b></td><td><code>job.allocatedtime</code><span class="meta">sum of resourceallocation.numberhours</span></td><td>Everything the PM has staffed, running forward to the end of the plan. Generated from the RTM. Above the contract it is an early warning, not an overrun: the hours have not been spent and some never will be.</td><td class="muted">The PM, through the RTM allocations.</td></tr><tr><td><b>Non-bill.</b></td><td><code>timebill.hours where isbillable = F</code><span class="meta">timetype = A</span></td><td>Time logged against the project that nobody is charged for. Shown because it exists. It is in no total on this page and never counts against a budget.</td><td class="muted">Consultants, when they log time.</td></tr><tr><td><b>Contracted</b></td><td><code>opportunity item quantity + won change orders</code><span class="meta">inside the client only</span></td><td>What the client bought: the hour lines on the SOW opportunity plus the change orders that genuinely add scope. Blank when the won opportunity carries no line items - NetSuite simply does not hold the figure then, and it is never inferred from money.</td><td class="muted">Whoever closes the opportunity.</td></tr><tr><td><b>Remaining</b></td><td><code>contracted - billable actual</code><span class="meta">inside the client only</span></td><td>Hours left on the contract. This is the only remaining figure a client may be told.</td><td class="muted">Nobody.</td></tr><tr><td><b>Billed / Unbilled</b></td><td><code>charge.stage = BILLED / READY_FOR_BILLING</code><span class="meta">use = Actual</span></td><td>Time approved and invoiced, against time approved and waiting to be invoiced. A large unbilled figure is delivered work nobody has charged for yet.</td><td class="muted">Whoever runs billing.</td></tr><tr><td><b>Invoiced / Paid / Outstanding</b></td><td><code>transactionline.foreignamount, transaction.foreignamountunpaid</code><span class="meta">type = CustInvc</span></td><td>What went out on invoices, what came back, and what is still owed. If one invoice spans two projects the outstanding figure is the whole invoice.</td><td class="muted">Accounting.</td></tr><tr><td><b>Renewal</b></td><td><code>custentity_bpc_ms_renewal_date</code><span class="meta">Managed Services only</span></td><td>When the retainer renews. Red once the date has passed.</td><td class="muted">The GSA.</td></tr><tr><td><b>RTM figures</b></td><td><code>custrecord_bpc_rtmp_* on the RTM project record</code><span class="meta">stored values</span></td><td>The RTM keeps its own copy of allocated hours, actual hours and contract value. It is a snapshot with a save date, shown beside the live figures inside each client.</td><td class="muted">Whoever presses Store Values.</td></tr></tbody></table>',
        'Hover any column heading on the sheet to see the same thing in one line.') +

      sect('What NetSuite will not update on its own',
        '<table class="grid"><thead><tr><th>Job</th><th>Why it matters</th><th>When</th></tr></thead><tbody><tr><td><b>Store Values on the RTM</b></td><td>Nothing refreshes the stored allocated hours, actual hours or contract value. Half the book has been weeks out of date at a time.</td><td class="muted">Whenever the allocations change, and before anybody reads the RTM as truth.</td></tr><tr><td><b>Load change-order hours into the project plan</b></td><td>A won change order does not add itself to plannedwork. Until somebody loads it, the plan reads short and the project looks over.</td><td class="muted">When the change order closes.</td></tr><tr><td><b>Approve time</b></td><td>projecttask.actualwork only moves on approval. Until then the project plan understates what has been delivered.</td><td class="muted">Weekly, and always before month end.</td></tr><tr><td><b>Put the fee table on the opportunity</b></td><td>Hour lines on the won opportunity are the only machine-readable record of what was sold. Without them nothing can state what the client bought.</td><td class="muted">At close.</td></tr><tr><td><b>Keep planned time entries and the plan in step</b></td><td>Six SOWs currently disagree by more than five per cent between the two forecasts.</td><td class="muted">When either one is revised.</td></tr></tbody></table>',
        'None of these happen automatically. Each one is a person opening a record and saving it, and each one makes a ' +
        'number on this page wrong until it is done.') +

      sect('The numbers do not agree - what is it?',
        '<table class="grid"><thead><tr><th>What you see</th><th>What it actually is</th><th>What to do</th>' +
        '<th>Whose call</th></tr></thead><tbody><tr><td><b>Actual is higher than Booked on the project record</b></td><td>Time has been logged but not yet approved, so projecttask.actualwork has not caught up.</td><td>Nothing, unless it is old. Approve the outstanding entries.</td><td class="muted">PM</td></tr><tr><td><b>Planned time entries do not match the project plan</b></td><td>Two forecasts of the same work: the plan the PM typed, and the planned time the PMO loaded. Neither is wrong on its own; they simply disagree.</td><td>Decide which one governs and make the other match.</td><td class="muted">PM and PMO</td></tr><tr><td><b>Allocated is far above the contract</b></td><td>More people are staffed than the contract pays for. It is a forecast, so it is an early warning rather than an overrun.</td><td>Review the allocations, or raise a change order.</td><td class="muted">PM</td></tr><tr><td><b>Allocated does not match its own allocation rows</b></td><td>job.allocatedtime is a stored total and the underlying rows have moved since.</td><td>Open the RTM, review the allocations and re-save.</td><td class="muted">PM</td></tr><tr><td><b>The RTM shows different numbers to this page</b></td><td>The RTM figures are a snapshot. Nothing refreshes them: verified on 12 Aug 2026 on two projects, one of which sat at 391.5 stored hours while 149 approved hours accumulated.</td><td>Press Store Values on the RTM. This page is live and does not need it.</td><td class="muted">PM</td></tr><tr><td><b>No contracted figure at all</b></td><td>The opportunity was closed won with no hour lines, so NetSuite holds nothing to read. The fee table usually lives as an image inside the Word SOW.</td><td>Load the fee-table lines on the opportunity, or read the signed SOW.</td><td class="muted">Whoever closed it</td></tr><tr><td><b>A change order is shown struck through</b></td><td>That change order repeats the SOW line for line, deposit included, so it restates the contract instead of extending it. Counting it would double the contract.</td><td>Nothing here. If it really is extra scope, the lines on it need correcting.</td><td class="muted">Whoever raised it</td></tr><tr><td><b>Hours booked with a date in the future</b></td><td>Not an error. NetSuite stores three kinds of time on the same record: A is real, P is the planned time entries the PMO forecasts with, and B is generated from the resource allocation. Only A is counted here.</td><td>Nothing.</td><td class="muted">Nobody</td></tr></tbody></table>',
        'Most disagreements are not data errors. Work down this list before assuming somebody typed something wrong.') +

      sect('Fields deliberately not used',
        '<div class="note" style="margin:0;border:0"><ul style="margin:0;padding-left:18px;line-height:1.9">' +
        '<li><code>custentity_bpc_esthours</code> is empty on every project.</li>' +
        '<li><code>projecttask.estimatedwork</code> reads the whole task tree, so it double counts. Root tasks only.</li>' +
        '<li><b>Money divided by a rate.</b> The rate on a project is not constant, so any hours figure derived from ' +
        'dollars is invented. Money stays money on this page.</li>' +
        '<li>The per-month retainer block (<code>custevent_bpc_prepaid_hours</code>) exists only on the monthly tasks, ' +
        'so it can never be compared against a whole project plan - the difference is usually a Knowledge Transfer task.</li>' +
        '<li>A task named <code>Non-Billable</code>. It does not exist on every project, and the plan only moves once ' +
        'time is approved. The flag on the time entry is used instead.</li>' +
        '</ul></div>') +

      sect('How the sheet works',
        '<div class="note" style="margin:0;border:0">One row per SOW, never a client total - a client with two ' +
        'contracts gets two rows, because hours belong to a contract and do not add up across them. Click any heading ' +
        'to sort, click again to reverse. The <b>View</b> control at the top decides which SOWs are listed and what is ' +
        'wrong with them. A client or SOW name opens the full detail: the contract, the change orders, every invoice, ' +
        'who did the work, and whether the numbers can be trusted. Every number links to the record it was read from, ' +
        'so any figure here can be checked in two clicks.</div>') +

      sect('Colours',
        '<div class="note" style="margin:0;border:0">Green is under 85 per cent of the plan, amber 85 to 100, red past ' +
        'it. Non-billable is grey and italic and is added to nothing. A green dot means every source agrees; a grey ' +
        'chip counts the ones that do not.</div>');
  },
  quality(q) {
    const rs = D.rows.filter(r=>match(r,q));
    const g = k => rs.filter(r=>r.issues.includes(k));
    const fut = g('futuretime').sort((a,b)=>b.future-a.future);
    const futTable = '<table class="grid"><thead><tr><th>SOW</th><th class="num">Future entries</th><th>Last entry dated</th><th class="num">Hrs in 30d</th></tr></thead><tbody>'+
      fut.map(r=>'<tr><td class="name"><b>'+esc(r.client)+'</b><br><a class="t" href="'+JOB(r.id)+'" target="_blank" rel="noopener">'+esc(r.sow)+'</a></td>'+
      '<td class="num neg">'+r.future+'</td><td class="num">'+(r.lastTime||'')+'</td><td class="num muted">'+f(r.h30)+'</td></tr>').join('')+'</tbody></table>';
    const nbHeavy = rs.filter(r=>r.nbUsed>0 && r.nbPlan!=null && r.nbUsed > Math.max(10, r.nbPlan*2)).sort((a,b)=>b.nbUsed-a.nbUsed);
    const nbTable = '<table class="grid"><thead><tr><th>SOW</th><th class="num">Non-billable planned</th><th class="num">Non-billable used</th><th class="num">Billable used</th></tr></thead><tbody>'+
      nbHeavy.map(r=>'<tr><td class="name"><b>'+esc(r.client)+'</b><br><a class="t" href="'+JOB(r.id)+'" target="_blank" rel="noopener">'+esc(r.sow)+'</a></td>'+
      '<td class="num muted">'+f(r.nbPlan)+'</td><td class="num neg">'+f(r.nbUsed)+'</td><td class="num">'+f(r.used)+'</td></tr>').join('')+'</tbody></table>';
    const nCk = rs.reduce((a,r)=>a+r.checks.length,0), nNo = g('nosold').length;
    return '<h1 class="page">Fix in NetSuite</h1>'+
      '<p class="lede"><b>'+nCk+' contradictions across '+rs.filter(r=>r.checks.length).length+' SOWs, and '+nNo+' won opportunities with no hour lines.</b> '+
      'Every item here is a fix somebody has to make in NetSuite - the console shows both numbers, names the fields, and guesses at nothing.</p>'+
      sect('Time entries dated in the future', fut.length?futTable:'<div class="empty">None.</div>',
        '<b>Not an error - corrected 12-Aug-2026.</b> These are the BPC <i>planned time entries</i>. NetSuite stores three kinds of time on the same record: <code>timetype = A</code> is actual, <code>B</code> is generated from the resource allocation, and <code>P</code> is planned. one project carried 2,487 actual entries and 6,478 planned ones, running two years out. The planned rows are how the PMO forecasts, and the EAC workbook is built on them. The real risk is the opposite of what this section first claimed: <b>anything that reads <code>timebill</code> without <code>timetype = A</code> is inflated</b>, which is exactly how a per-person check can report someone as 117 hrs over when they are 8 hrs under.') +
      sect('Sources that disagree with each other',
        (()=>{ const all = rs.flatMap(r=>r.checks.map(c=>[r,c]));
          if(!all.length) return '<div class="empty">Every source agrees.</div>';
          const FIX = {
            'plan vs SOW': ['projecttask.plannedwork', 'Open the project plan and set the root tasks to the hours on the signed SOW, or load the fee-table lines on the opportunity.'],
            'allocation vs its time rows': ['resourceallocation.numberhours', 'Open the RTM and re-run Rate Card to Allocation - the stored allocatedtime and its own allocation rows have drifted apart.'],
            'time vs plan actuals': ['timebill approval', 'Approve the outstanding time entries, or find the entries booked against a task outside the plan.'],
            'planned time vs plan': ['planned time entries', 'Regenerate the planned time entries from the project plan, or fix the plan - the PMO forecast and the plan no longer agree.'],
            'change orders not counted': ['custbody_bpc_opp_original_sow', 'Point the change order at the right SOW, or load its hours into the project plan.'],
          };
          return '<table class="grid"><thead><tr><th>Client / SOW</th><th>What disagrees</th><th>Field to change</th><th>What to do</th></tr></thead><tbody>'+
          all.map(([r,c])=>{ const fx = FIX[c[0]] || ['',''];
          return '<tr><td class="name"><button class="t" data-client="'+esc(r.client)+'">'+esc(r.sow)+'</button>'+
          '<span class="meta">NS '+r.id+'</span></td>'+
          '<td><span class="chip gap">'+esc(c[0])+'</span><span class="meta">'+esc(c[1])+'</span></td>'+
          '<td><code>'+esc(fx[0])+'</code></td><td>'+esc(fx[1])+'</td></tr>'; }).join('')+'</tbody></table>'; })(),
        'Two NetSuite fields that ought to say the same thing and do not. None of these is fixed here - each one is a correction somebody has to make in NetSuite. Ranked by nothing: they all matter to whoever owns that project.') +
      sect('Won opportunity has no line items', table(g('nosold'),true),
        'The SOW was closed won with no hour lines, so NetSuite holds no sold figure and the console falls back to the project plan. Fix: load the fee-table lines on the opportunity.') +
      sect('Plan disagrees with what was sold', table(g('planmismatch'),true),
        'More than 5% apart. The plan drives every other report, so it is the one to correct.') +
      sect('Duplicate change orders', table(g('dupco'),true),
        'Two won COs on the same SOW with identical hours. Both are counted, so remaining may be overstated by one of them.') +
      sect('Non-billable well above what was planned', nbHeavy.length?nbTable:'<div class="empty">None.</div>',
        'Non-billable never counts against the budget, so it is not a budget problem  but time consistently landing here instead of on the billable task is either a scope conversation or a posting habit worth correcting.') +
      sect('No time booked in 45+ days, still open', table(g('stale'),true),
        'Either the work stopped and the SOW should be closed, or time is being booked somewhere else.');
  }
};

let view='portfolio', q='', client=null, band=null;
// Held work is in by default: those are the SOWs nobody is watching, and the point of putting
// this in front of Joe and Jeff is that they spot the wrong ones.
let state = new Set(['open','hold']), flags = new Set(), ddOpen = false;
let psort = 'client', pdir = 1;
// The default view keeps held work in: those are the SOWs nobody is watching, and the point of
// putting this in front of Joe and Jeff is that they spot the wrong ones.
const CRUMB = {portfolio:'Portfolio',help:'Help'};
function render(){
  const pane = document.getElementById('pane');
  pane.innerHTML = (client ? detail(client) : VIEWS[view](q)) +
    '<footer class="legal noprint">Read from NetSuite account <YOUR_ACCOUNT_ID> on '+D.runDate+'. '+
    'Sold = deduplicated 1000.xx / 2000.xx / 1000PS lines on the job\\'s primary opportunity, suppressed when it cannot be the SOW figure. '+
    'Plan and Used = root project tasks minus the Non-Billable node. Allocated = job.allocatedtime. '+
    'Billed / unbilled = charge.stage. Nothing on this page is derived from money.</footer>';
  document.getElementById('crumb').textContent = client ? client : CRUMB[view];
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active', !client && b.dataset.view===view));
  pane.querySelectorAll('[data-goto]').forEach(el=>el.onclick=()=>{client=null;view=el.dataset.goto;render()});
  pane.querySelectorAll('[data-client]').forEach(el=>el.onclick=()=>{client=el.dataset.client;render();document.querySelector('.content').scrollTop=0});
  pane.querySelectorAll('[data-sort]').forEach(el=>el.onclick=()=>{const k=el.dataset.sort; if(sortBy===k){sortDir=-sortDir}else{sortBy=k;sortDir=-1} render()});
  pane.querySelectorAll('[data-band]').forEach(el=>el.onclick=()=>{band=(band===el.dataset.band?null:el.dataset.band);render()});
  pane.querySelectorAll('[data-back]').forEach(el=>el.onclick=()=>{client=null;render()});
}
document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>{client=null;band=null;view=b.dataset.view;render()});
document.getElementById('crumb-root').onclick=()=>{client=null;view='portfolio';render()};
document.addEventListener('click',e=>{
  const ps=e.target.closest('[data-ps]');
  if(ps){ const k=ps.dataset.ps; if(psort===k) pdir=-pdir; else { psort=k; pdir=(k==='client'||k==='sow')?1:-1; } render(); return; }
  if(e.target.closest('#ddb')){ ddOpen=!ddOpen; render(); return; }
  if(e.target.closest('[data-clear]')){ flags.clear(); render(); return; }
  if(!e.target.closest('.dd') && ddOpen){ ddOpen=false; render(); }
});
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.dataset.st){ const k=t.dataset.st; if(state.has(k)&&state.size>1) state.delete(k); else state.add(k); ddOpen=true; render(); }
  if(t.dataset.fl){ const k=t.dataset.fl; flags.has(k)?flags.delete(k):flags.add(k); ddOpen=true; render(); }
});



document.getElementById('q').addEventListener('input',e=>{q=e.target.value.trim().toLowerCase();
  if(client&&q)client=null; render()});
const cnt = (id,k) => { const e = document.getElementById(id); if (e) e.textContent = k; };
render();
</script>

<!-- Auth: dedicated Firebase project example (kept apart from the client-facing
     Customer Hub on purpose  this console holds every client's contract data).
     Google only; BPC runs on Google Workspace. Non-BPC accounts are signed straight out. -->
<script type="module">
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js';
const DOMAIN = 'yourcompany.com';  // only this Workspace domain may sign in
const app = initializeApp({
  apiKey: 'YOUR_FIREBASE_API_KEY',
  authDomain: 'YOUR_PROJECT.web.app',
  projectId: 'YOUR_PROJECT',
  storageBucket: 'YOUR_PROJECT.firebasestorage.app',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_FIREBASE_APP_ID',
});
const auth = getAuth(app);
const $ = i => document.getElementById(i);
const err = m => { const e=$('login-err'); e.textContent=m; e.hidden=!m; };
const google = new GoogleAuthProvider();
// hd pins the picker to the BPC Workspace. No login_hint (it belongs to one person, not the
// team) and no prompt=select_account: forcing the chooser makes Google ask for a password
// when that account is not already in the browser session, which reads as "the app wants my
// password" when it is really Google's own login. Left alone, an existing session goes straight
// through.
// No hd: it hides every account that is not already a BPC session and drops the user on an
// empty email form. Without it Google shows whatever accounts the browser has, so a BPC
// account that is already signed in is one click. Non-BPC accounts are signed straight out
// below, so the domain is still enforced - by us, not by the picker.
google.setCustomParameters({ prompt: 'select_account' });
$('btn-google').onclick = async () => {
  err('');
  try { await signInWithPopup(auth, google); }
  catch (e0) {
    // Popup blocked or closed - fall back to the redirect flow rather than dead-ending.
    if (e0 && (e0.code === 'auth/popup-blocked' || e0.code === 'auth/operation-not-supported-in-this-environment')) {
      try { await signInWithRedirect(auth, google); } catch (e1) { err('Google sign-in failed. Try again.'); }
    } else if (e0 && e0.code === 'auth/popup-closed-by-user') { err(''); }
    else { throw e0; }
  }
  try { }
  catch (e) {
    const c = e?.code;
    if (c === 'auth/operation-not-allowed') err('Google sign-in is not enabled on this Firebase project yet.');
    else if (c === 'auth/unauthorized-domain') err('This domain is not authorised in Firebase Authentication yet.');
    else err('Google sign-in failed. Try again.');
  }
};
// Complete the same-tab redirect flow and surface provider/configuration failures.
// onAuthStateChanged below remains the source of truth for showing the console.
getRedirectResult(auth).catch(e => {
  const c = e?.code;
  if (c === 'auth/operation-not-allowed') err('Google sign-in is not enabled on this Firebase project yet.');
  else if (c === 'auth/unauthorized-domain') err('This domain is not authorised in Firebase Authentication yet.');
  else err('Google sign-in failed. Try again.');
});
$('btn-out').onclick = () => signOut(auth);
onAuthStateChanged(auth, user => {
  const email = (user?.email || '').toLowerCase();
  const ok = !!email && email.endsWith('@' + DOMAIN);
  if (user && !ok) { signOut(auth).then(() => err('This console is limited to Example Client accounts.')); return; }
  $('login').hidden = ok; $('app').hidden = !ok;
  if (ok) {
    const nm = user.displayName || email.split('@')[0];
    $('me-name').textContent = nm; $('me-mail').textContent = email;
    $('me-ava').textContent = nm.split(/[\\s.]+/).slice(0,2).map(s=>s[0]).join('').toUpperCase();
  }
});
</script>
</body>
</html>`;

fs.mkdirSync(path.join(DIR, "dist"), { recursive: true });
// Parse the page's own script before shipping it. An apostrophe inside a single-quoted
// string ("the EAC workbook") is enough to blank the whole console, and the page still
// deploys happily - the browser is the only thing that finds out. 12-Aug-2026.
{
  const src = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!src) throw new Error("build: no inline script found in the page");
  try { new Function(src[1]); }
  catch (e) { throw new Error("build: the generated page has a syntax error and was NOT written -> " + e.message); }
  // Parsing is not enough: calling a build-time helper like n() from browser code parses
  // perfectly and then renders a blank page. So actually RUN the script against a stub DOM
  // and make sure the first view produces markup. 12-Aug-2026, twice in one afternoon.
  const els = {};
  const el = () => ({ textContent: "", innerHTML: "", hidden: false, style: {},
    classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {},
    querySelectorAll: () => [], setAttribute() {}, removeAttribute() {} });
  const g = global;
  const prevDoc = g.document, prevWin = g.window;
  const realIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  g.document = { getElementById: (i) => {
      if (!realIds.has(i)) return null;   // the page must survive asking for something absent
      return els[i] || (els[i] = Object.assign(el(), { id: i, textContent: i === "data" ? asciiJson(data) : "" }));
    },
    querySelectorAll: () => [], querySelector: () => el(), addEventListener() {}, body: el() };
  g.window = { addEventListener() {}, location: { hash: "" }, print() {} };
  try {
    const out = new Function(src[1] + "; return { VIEWS: VIEWS, detail: detail, D: D };")();
    const pane = els["pane"];
    if (!pane || pane.innerHTML.length < 500)
      throw new Error("the first view rendered " + (pane ? pane.innerHTML.length : 0) + " characters");
    // Every view, not just the one that happens to load first: invoices and pva both shipped
    // broken because only the landing page was checked.
    for (const k of Object.keys(out.VIEWS)) {
      let html2;
      try { html2 = out.VIEWS[k](""); }
      catch (e) { throw new Error("view '" + k + "' threw: " + e.message); }
      if (!html2 || html2.length < 200) throw new Error("view '" + k + "' rendered almost nothing");
    }
    try { out.detail(out.D.clients[0].name); }
    catch (e) { throw new Error("the client detail threw: " + e.message); }
  } catch (e) {
    throw new Error("build: the page threw while rendering and was NOT written -> " + e.message);
  } finally { g.document = prevDoc; g.window = prevWin; }
}
fs.writeFileSync(path.join(DIR, "dist", "index.html"), html);
console.log(`dist/index.html  ${clients.length} clients, ${rows.length} open SOWs, ${closed.length} closed, ${(html.length / 1024).toFixed(0)} KB`);

