# Building a label PO from a Linear ticket

Not every label order comes through the public form. Most of the historical
ones — and anything Graham raises by hand — arrive as a **SALES ticket in
Linear** with the paperwork attached. There is no `label_orders` row to query
and no dashboard JSON to download, so the order data has to be assembled from
the attachments.

This file is the sourcing playbook for that path. The output is the same Ramp
block; only the intake differs.

## The rule that governs the whole thing

**Go and find it. Do not come back with a list of questions.**

Nearly every field someone would ask about is already sitting in a document on
the ticket, in the SharePoint mirror, or in the ToolHound OS Salesforce data.
Enumerating gaps is not the work — closing them is. Ask a person only after the
three sources below have all come up empty, and then ask for the one thing that
is genuinely absent rather than a checklist of everything unconfirmed.

Two corollaries that have actually bitten:

- **A Metalcraft PO needs a ship-to name, address and attention line. It does
  not need the customer's email address.** An order was held up chasing a
  contact email that no Metalcraft PO would ever carry. If the field is not on
  the PO, it is not a blocker.
- **A missing Metalcraft quote is never a blocker.** Metalcraft quote *after*
  they receive the PO. Rate is `0.00`. See the main SKILL.md.

## Finding the ticket

Search Linear by title, not by label:

```
mcp__Linear__list_issues  query: "label order"  team: SALES
```

The **`Label Order` label is unreliable** — it is missing from roughly half the
order threads. Titles come in two shapes: `[Label Order] submission` (raised
through Graham's intake form, customer name is only in the body) and
`<Customer> Label Order` (raised by hand).

A `[Label Order] submission` body is a set of fixed headed sections:

```
Today's Date / Description / Salesforce Link / Invoice Recipient /
Billing Email / Customer Quote / Label Order Form / MetalCraft Quote /
Customer PO / Customer logo / Other
```

Each document section holds a `linear-embed` blob with the file's `name` and a
signed `href`. Read the section headings before opening anything — `Invoice
Recipient` and `Billing Email` are plain text in the body and often answer the
billing question outright.

Parent tickets usually carry two subtasks (`Populates Label Order Form`,
`Update SF with last label #`). Work the parent.

## Reading the attachments

**The signed `href` on a Linear embed is not fetchable from this sandbox** —
`uploads.linear.app` is refused by the egress proxy. Do not spend a turn on
curl.

Instead, the same files are mirrored to SharePoint:

```
toolhound.sharepoint.com / Sales / Documents / Invoices / Linear Files /
```

named `SALES-<n> - <original filename>`. Find them with
`mcp__Microsoft_365__sharepoint_search` on the filename or on the ticket
number, then read with `mcp__Microsoft_365__read_resource` on the returned
`file:///` URI.

What reads and what does not:

| Format | Result |
|---|---|
| `.docx`, `.doc` | reads fine |
| `.csv`, `.xlsx` | reads fine |
| PDF with a text layer (POs, quotes, generated forms) | reads fine |
| **Scanned PDF** (a printed form someone signed and scanned) | **returns empty — there is no OCR** |

That last row is also the **signed/unsigned tell**: a signed acknowledgement
form comes back as a scanned PDF, an unsigned one is still the Word template.
If the Label Order Form section holds a `.doc` or `.docx`, the customer has not
signed yet. If it holds a PDF that reads empty, they have — and you will need
someone to read the values off it, or a screenshot.

## Which document answers what

Work them in this order. The customer PO is by far the richest and is regularly
skipped.

**Customer PO** — the single best document. A real one (PCL Tools, PO
`W801-M0596-30472`) carried all of:

- Ship-to name and full address
- **Invoice-to address and email** (`INDOH@pcl.com`)
- The attention line
- The correct legal entity — which settles the NetSuite Customer/Job question
- Quantity, UOM, unit description and the customer-facing price
- Ship-via / carrier terms, date required, project number
- The buyer who cut the PO, separately from the attention line

Note the price on a customer PO is what the **customer pays ToolHound**, not
what ToolHound pays Metalcraft. It never becomes the PO rate.

**Label Order Form (CSV / XLSX)** — when the order went through the intake
form, this is the structured record: Order Date, Company Name, Order Approved
by, Shipping Address, Attention, Logo or Text on Labels, Label Sequence Start,
Label Sequence End. The size is usually in the **filename**
(`Premium Poly Pro Label Order Form_(1.50_ x 0.75_).csv`), not in the columns.

**Label Order Acknowledgement (signed PDF)** — governs size and sequence when
it conflicts with anything else. Usually scanned, so usually unreadable here.

**Customer Quote** — the ToolHound-side quote. Useful for the quote number and
for confirming quantity, not for vendor pricing.

**Ticket body** — `Invoice Recipient`, `Billing Email`, the Salesforce link,
and Graham's freehand notes, which carry real instructions ("Monochrome, not
colour", "black where the logo is green", "ask for a proof first", "18 rolls of
500, I will deliver 2 from stock"). Read the Description. It is not decoration.

## Last resort: the Salesforce data

Contact details that are nowhere in the paperwork may be in the **ToolHound OS**
Supabase project `lzblhtndrwdwoyvktxno`, which mirrors ToolHound's Salesforce.
(The other project, `ayqcteloqdrlemehozzk`, is the label order form — different
database, do not confuse them.)

There is **no contacts table**. Contact identity is denormalised onto cases and
opportunities:

```sql
select contact_name, contact_email, account_name
from raw_cases
where account_name ilike '%<customer>%'
   or contact_name ilike '%<surname>%'
union all
select contact_name, contact_email, account_name
from raw_opportunities
where account_name ilike '%<customer>%';
```

Departed contacts are marked inline with a `(GONE)` suffix on the name — filter
them out. `raw_cases` is the densest source (38k rows); `raw_gone_contacts` is
empty despite its name.

Beware: an account can have many rows and one customer's name can swamp a
`limit`. Query the specific account rather than a broad `or` chain.

Two things this database is **not**: the Gmail account wired into a Beacon
session is Ian's Beacon mailbox, and the Salesforce connector is Beacon's M&A
CRM. Neither holds ToolHound customer data. Do not search them for it.

## Worked example — PCL Nisku, SALES-170

Starting point: a ticket, an unreadable scanned acknowledgement form, and an
apparent pile of blockers (no NetSuite entity, no ship-to email, a quote number
that appeared to collide with another order, no Metalcraft quote).

Reading the customer PO closed all of them:

| Field | Value | Source |
|---|---|---|
| Ship to | PCL Tools (Module Yard), 2307 - 4 Street, Nisku, Alberta T9E 7W7 | customer PO |
| Attention | Brian | ack form |
| Invoice to | PCL Tools Inc., same address, `INDOH@pcl.com` | customer PO |
| NetSuite Customer/Job | **PCL Tools Inc.** — not PCL Constructors, not PCL Arizona | customer PO |
| Quantity | 1 roll, 5,000 labels | customer PO |
| Ship via | DUNRITE EXPRESS COLLECT, required Aug 4 | customer PO |
| Rate | `0.00` | always |

The quote number `GC-24-175A` also appeared on a second order. The PO said
"reference quote GC-24-175A for item pricing only" — a rate card cited on two
orders, not a data-entry collision. The document explained itself.

The lesson is the one at the top of this file: the questions answered
themselves the moment the PO was actually opened.
