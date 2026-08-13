---
name: hours-console
description: Refresh and publish the Hours Console — per-SOW sold/CO/plan/allocated/used/remaining, every paid and unpaid invoice, and who has worked past their allocation. Use when someone asks for project hours, remaining hours, budget burn, invoice status, "are we over on X", or asks to update the hours console.
---

# Hours Console

A single self-contained HTML page built from NetSuite. `node build.js` reads the five
JSON files in `data/` and writes `dist/index.html`; `firebase deploy --only hosting`
publishes it to the hours console.

Nothing here is estimated. **Never derive hours from money** — no `$ ÷ rate`, no deposits,
no `% complete`. If NetSuite does not hold the number, the page says so.

## Refreshing the data

Each file in `data/` is the output of one SuiteQL query against NetSuite (your NetSuite account).
Run them, write the JSON, then `node build.js`. Everything is keyed by **job id** as a string.

### Rules that the queries encode — do not "simplify" them

1. **Root tasks only.** A project task list is a tree. Sum `plannedwork` / `actualwork`
   where `parent IS NULL`, then subtract the topmost `NON-BILLABLE%` node. Summing every
   level double counts; `estimatedwork` reads the whole tree and is wrong.
2. **Non-billable is shown, never added.** It is not part of Used, Remaining or any total.
3. **A change order is only added when it adds scope.** Some COs are the whole contract
   restated: they repeat the SOW's own line quantities and its deposit line. Adding those
   invents hours the client never bought (seen in the field: a project published 1,056.7 contracted hours when the real figure was 509.85, and it was already over). When a CO repeats a SOW
   line quantity, set `co_manual` in `data-extras.json` and explain it in `co_source`.
4. **Sold is a reference, not the basis.** The primary opportunity is often a change order,
   a restatement, or empty. Remaining and Consumption run on the project plan plus real COs.
   The word "Purchased" is only correct when someone has read the signed SOW.
5. **The monthly retainer block is not the plan.** `custevent_bpc_prepaid_hours` exists only
   on the monthly tasks, so it can never be compared against a whole project plan — the
   difference is usually Knowledge Transfer, not a contradiction (seen on a managed-services SOW).
6. **The project is on the invoice LINE.** `transactionline.entity` = the job. The invoice
   header entity is the parent customer, so filtering on it returns nothing.

### data/data-jobs.json — one row per open SOW

`job` where the project is open, plus for each: `planned` and `consumed` (root tasks,
Non-Billable removed), `nb_planned` / `nb_actual` (the Non-Billable node), `approved`
(charges), `jobtype`, `startdate`, `enddate`, renewal date, auto-renew, rollover cap, and
`cos` — the won change orders whose `custbody_bpc_opp_original_sow` points at the job.

### data/data-extras.json — `{opp, alloc, sow_link, sold}` per job

- `opp` — `job.custentity_bpc_primaryopportunity`
- `alloc` — `job.allocatedtime` (identical to `SUM(resourceallocation.numberhours)`)
- `sold` — the deduped `1000.xx / 2000.xx / 1000PS` quantities on that opportunity
- `sold_manual` + `sold_source` — override read from a signed SOW
- `co_manual` + `co_source` — override when the COs are restatements

### data/data-billing.json — charge roll-up per job

```sql
SELECT tb.customer AS j, c.stage, SUM(c.quantity)
FROM charge c INNER JOIN timebill tb ON tb.id = c.timerecord
WHERE tb.customer IN (<job ids>) AND c.use = 'Actual'
GROUP BY tb.customer, c.stage
```
`BILLED` -> `billed`, `READY_FOR_BILLING` -> `ready`.

### data/data-invoices.json — every invoice, paid and unpaid

```sql
SELECT tl.entity AS j, t.tranid, t.trandate, t.foreignamountunpaid,
       SUM(tl.foreignamount),
       (SELECT SUM(c.quantity) FROM charge c
          INNER JOIN timebill tb ON tb.id = c.timerecord
        WHERE c.invoice = t.id AND tb.customer = tl.entity) AS hrs
FROM transaction t INNER JOIN transactionline tl ON tl.transaction = t.id
WHERE t.type = 'CustInvc' AND tl.entity IN (<job ids>)
GROUP BY tl.entity, t.id, t.tranid, t.trandate, t.foreignamountunpaid
```
Amounts come back negative — store them positive. `hrs` null means the invoice carries no
time: a deposit, a monthly block or a fixed fee. An amount of 0 with hours on it is time
drawn against a block invoiced up front. Chunk the query ~15 jobs at a time; the full set
is ~800 rows and overflows the tool output in one go.

### data/data-activity.json — where the time is landing

Last entry date, hours in the last 30 days, count of **future-dated** entries, distinct
people, and the top tasks of the last 60 days, from `timebill`.

### data/data-links.json — `open` map `{jobId: [rtmId, driveUrl]}` and the `closed` array

`custentity_bpc_rtmproject` and `custentity_bpc_sow_link`, plus the non-open SOWs with
their status codes.

## Who has worked past their allocation

The question the PMs actually need answered. Two ready-made saved searches, runnable
directly — no CSV, no pivot:

| Saved search | What it gives |
| --- | --- |
| `CUSTOMSEARCH_BPC_PROJ_TASKS_PLANNED_ACTU` | project tasks where actual > planned, with PM and EM |
| `CUSTOMSEARCH_BPC_RESOURCE_ALLOCATIONS_TA` | allocation per person **with the task** |
| `CUSTOMSEARCH3375` | allocated vs planned variance per project |
| `CUSTOMSEARCH_BPC_CWCOOPPS` | every won change order with its originating SOW |

Or in SuiteQL, per person:

```sql
SELECT ra.project, ra.allocationresource, SUM(ra.numberhours) AS allocated,
       (SELECT SUM(tb.hours) FROM timebill tb
        WHERE tb.customer = ra.project AND tb.employee = ra.allocationresource) AS actual
FROM resourceallocation ra WHERE ra.project IN (<job ids>)
GROUP BY ra.project, ra.allocationresource
```
`BUILTIN.DF()` on `allocationresource` makes this query fail — join to `employee` for names.

## Generating a PDF

**Always ask who it is for before generating anything.** The two reports are not the same
document and the difference is not cosmetic.

```bash
node build.js                                     # refresh dist/data.json first
node pdf/report.js "Example Client" --client     # what the customer may see
node pdf/report.js "Example Client" --internal   # estimate vs spend, never sent
```

- `--client` prints contracted, used, remaining and every invoice with what is still
  outstanding. It **refuses to build** when any SOW has no confirmed signed-SOW figure,
  because "Purchased" is a contractual claim and only the signed SOW makes it. Fix by
  setting `sold_manual` + `sold_source` in `data/data-extras.json`.
- `--internal` prints planned vs actual, staffing and where the time is landing, with an
  "internal only, do not send" band across the top. The client agreed to a scope and a
  total, not to our estimate - sending this invites an argument about hours already paid.

Both use the BPC cover, palette and type from the engagement-report kit, so a client PDF
from here matches the branded reports you already send. The PDF step drives a
headless Chrome over the DevTools protocol:

```bash
chrome --headless=new --remote-debugging-port=9222 --disable-gpu about:blank
```

If Chrome is not listening the HTML is still written to `dist/reports/` and can be printed
by hand.

## Publishing

```bash
node build.js
firebase deploy --only hosting
```

The published page is Google sign-in only, restricted to one Workspace domain. It is internal:
nothing on it goes to a client without a human reading the signed SOW first.
