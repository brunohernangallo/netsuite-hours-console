# NetSuite Hours Console

Every open SOW in one sheet, read straight from NetSuite: what the plan says, what has been
staffed, what has been booked, what has been invoiced, and who did the work. Click a client
for the contract, the change orders and the invoicing.

One self-contained HTML page. No server, no database, no framework — a handful of JSON files
and one script.

```bash
node build.js     # data/*.json -> dist/index.html
open dist/index.html
```

It ships with **invented sample data**, so it runs before you connect anything. Replace
`data/` with your own pull; the shape is what matters.

## Why this exists

NetSuite holds "how many hours does this client have" in four places, and they disagree:

| Source | What it really is | Fails when |
| --- | --- | --- |
| `projecttask.plannedwork` | what a PM typed at kickoff | typed wrong, or a change order was never loaded into it |
| opportunity item lines | what was quoted | the won opportunity has no lines at all, or the "CO" restates the whole contract |
| `job.allocatedtime` | forward staffing, the EAC view | above the contract on purpose — a forecast, not an overrun |
| the RTM / project custom record | a stored snapshot of all of the above | nothing refreshes it; it silently goes weeks stale |

Reading the wrong one and calling it *Purchased* is how a project that is over budget gets
published as 54% and green. This page puts them side by side, names the NetSuite field behind
every number, links each one to its record, and refuses to print a figure it cannot stand
behind.

## Using it with Claude Code

**[SETUP.md](SETUP.md) has the whole thing**: the read-only NetSuite role and its exact
permissions, the integration record and access token, and how to run each report.

This is built to be driven conversationally. Open the repo in Claude Code and ask for what you
want — *refresh the hours*, *why is this client over budget*, *build the client PDF*. The skill
in `.claude/skills/hours-console/` carries the SuiteQL for each file, the field map, and the
rules below with the incident behind each one.

You need a way to reach NetSuite:

- **The NetSuite MCP connector** — fine for reading. It times out on anything bigger than one
  project per query, so the heavy pulls are chunked.
- **A read-only token** (integration record + access token, SuiteQL permission) — faster, and
  required by `scripts/pull-invoice-detail.js`.

Field ids like `custentity_bpc_primaryopportunity` are specific to the account this was built
against. Map them to your own; the skill says what each one is for.

## Rules baked in

- **Hours are never derived from money.** No `$ ÷ rate`, no deposits, no `% complete`.
- **Non-billable is shown, never added** to Used, Remaining or any total.
- **Actual means billable actual** — the same figure the project record calls Actual Billable Hrs.
- **A change order counts only if it adds scope.** One that repeats the SOW's own line
  quantities is the contract restated, not an increment; counting it doubles the contract.
- **Root tasks only.** The task list is a tree; summing every level double counts.
- **"Purchased" needs the signed SOW.** The client-facing PDF refuses to build without it.

Every one of these came from getting it wrong in front of somebody first.

## The snapshot trap

If your account keeps a project custom record with stored totals, check whether anything
refreshes it. In the account this was built against, nothing did:

- One project's record was last saved on the 31st; five time entries were created over the
  following ten days; the stored figure never moved.
- Another sat at 391.5 stored hours while 149 approved hours accumulated. The live figure was
  540.5 — exactly 391.5 + 149.

So the console shows both, with the save date, inside each client. A gap there is not a data
error; it is a snapshot waiting for someone to press **Store Values**.

## Layout

```
build.js                          data/ -> dist/index.html (and dist/data.json)
data/                             one file per NetSuite pull, keyed by job id
pdf/report.js                     branded PDF, --client or --internal
scripts/pull-invoice-detail.js    who worked on each invoice (needs a token)
.claude/skills/hours-console/     the queries, the field map, the rules
```

`build.js` will not write the page if the generated script fails to parse, or if any view
throws or renders empty. Both of those shipped once before the gate existed.

## Publishing

Optional. `dist/index.html` is a plain file — host it anywhere. There is a Google sign-in gate
in `build.js` restricted to one Workspace domain; fill in your Firebase config, or delete the
block if you are serving it somewhere already private.

## Licence

MIT. It contains no data — bring your own.
