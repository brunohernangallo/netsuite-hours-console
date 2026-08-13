# Setup

Two things to arrange: **a NetSuite role Claude can read with**, and **where the JSON comes
from**. Then everything else is one command.

---

## 1. The NetSuite role

Do not point this at an administrator login. Make a role that can read the project and billing
records and nothing else — then, if something ever goes wrong, the worst case is a report that
looks odd.

### Create the role

**Setup → Users/Roles → Manage Roles → New.** Call it something obvious, e.g. `Claude — Hours
Reporting (Read Only)`.

Set:

| Setting | Value |
| --- | --- |
| Centre Type | Classic Centre |
| Single sign-on only | unchecked |
| Web Services Only Role | checked, if this role is used only by the token |
| Subsidiary restrictions | whatever matches the data you want back |

Then the permissions. **Every one of these is View, never Edit or Full.**

**Permissions → Transactions**
- Find Transaction — *View*
- Invoice — *View*
- Opportunity — *View*
- Sales Order — *View* (only if your SOWs run through orders)
- Track Time / Time Tracking — *View*

**Permissions → Lists**
- Projects — *View*
- Project Tasks — *View*
- Employees — *View* (needed to put a name next to the hours)
- Customers — *View*
- Items — *View*
- Resource Allocations — *View*
- Charge — *View* (this is what carries billed vs unbilled hours)
- Custom Record Entries — *View*, plus the specific custom record if your account keeps a
  project/RTM record with stored totals

**Permissions → Reports**
- SuiteAnalytics Workbook — *Edit* (counter-intuitive: SuiteQL over REST needs Edit here, not
  View. It does not grant write access to any record.)

**Permissions → Setup**
- REST Web Services — *Full*
- Log in using Access Tokens — *Full*
- SuiteAnalytics Workbook — *View*

Assign the role to a user — ideally a dedicated integration user, not a person.

### Enable the features

**Setup → Company → Enable Features → SuiteCloud**, tick:

- REST Web Services
- Token-based Authentication
- SuiteAnalytics Workbook

### Create the token

1. **Setup → Integration → Manage Integrations → New.** Name it `Claude Hours Console`, tick
   *Token-based Authentication*, untick *TBA: Authorization Flow* and *OAuth 2.0*. Save, and
   copy the **Consumer Key** and **Consumer Secret** — NetSuite shows them once.
2. **Setup → Users/Roles → Access Tokens → New.** Pick the integration, the user and the role
   you just made. Copy the **Token ID** and **Token Secret** — also shown once.

Put them in `scripts/.env` (gitignored):

```
NS_ACCOUNT=1234567
NS_CONSUMER_KEY=...
NS_CONSUMER_SECRET=...
NS_TOKEN_ID=...
NS_TOKEN_SECRET=...
```

Your account id is in the URL when you are logged in: `https://1234567.app.netsuite.com`. If it
contains an underscore (a sandbox, `1234567_SB1`), the REST host uses a dash instead.

### Test it

```bash
node scripts/pull-invoice-detail.js
```

If the credentials are wrong you get a 401 with the reason. A 403 usually means the role is
missing *SuiteAnalytics Workbook — Edit*.

### The alternative: the MCP connector

If you would rather not create a token, Claude Code can talk to NetSuite through its MCP
connector and you can skip all of the above. It reads fine. Its one limit, measured: a query
that groups charges by person returns instantly for **one** project and times out at **six**,
so the bulk pulls have to be chunked by hand, and `pull-invoice-detail.js` will not run.

---

## 2. Getting the data in

Each file in `data/` is the output of one SuiteQL query. The queries, the field mapping and
the rules that must not be "simplified" are in
[`.claude/skills/hours-console/SKILL.md`](.claude/skills/hours-console/SKILL.md).

The fastest route is to open the repo in Claude Code and say:

> Refresh the hours data from NetSuite and rebuild.

It will run the queries in the skill, write `data/*.json` and run the build. What you should
check before trusting the output:

- **Field ids are account-specific.** `custentity_bpc_primaryopportunity`,
  `custbody_bpc_opp_original_sow`, the project custom record type — all of those are named for
  the account this was built against. Map them to yours; the skill says what each is for.
- **Project status codes differ.** The build treats some statuses as open, some as "on hold or
  in review", and some as finished. Check `data-links.json` against your own list.

---

## 3. Running the reports

### The console

```bash
node build.js
```

Writes `dist/index.html` — open it directly, or host it. The build refuses to write the file if
the generated page fails to parse or if any view renders empty.

### A client PDF

```bash
node pdf/report.js "Northwind Foods" --client     # what a customer may see
node pdf/report.js "Northwind Foods" --internal   # estimate vs spend, never sent
```

Two different documents, and the difference is not cosmetic:

- `--client` prints contracted, used, remaining and every invoice with what is outstanding. It
  **refuses to build** when a SOW has no confirmed signed-SOW figure, because *Purchased* is a
  contractual claim and only the signed document makes it.
- `--internal` prints estimate against spend, staffing and where the time landed, with a
  do-not-send band across the top.

The PDF step drives a headless Chrome over the DevTools protocol. Start one first:

```bash
chrome --headless=new --remote-debugging-port=9222 --disable-gpu about:blank
```

If Chrome is not listening, the HTML is still written to `dist/reports/` and can be printed by
hand.

### Who worked on each invoice

```bash
node scripts/pull-invoice-detail.js
```

Walks every project one at a time and writes `data/data-invoice-detail.json`. Needs the token.

### Weekly

There is no scheduler in here on purpose. Wire the two commands to whatever you already use:

```bash
node scripts/pull-invoice-detail.js && node build.js
```

---

## What to expect the first time

The numbers will not agree with each other, and that is the point of the tool rather than a
fault in it. In the account this was built against, 20 of 63 open SOWs had at least two fields
that contradicted each other — about half of those were simply time entered and not yet
approved, and the rest were real: plans typed short of the signed SOW, change orders cloned
from the whole contract instead of the increment, and stored snapshots weeks out of date.

The console names the field behind every figure and links it to the record so you can settle
each one yourself. It does not guess, and where NetSuite holds no answer it says so instead of
inventing a baseline.
