# Ramp PO spec — Metalcraft label orders

The durable reference for the Metalcraft vendor PO (Output 1 of the label order
workflow). Lifted from the `toolhound-invoice-prep` skill so this skill does not
depend on it being loaded. Read this when you need a block verbatim, or when
Ramp's form does not look like what the script assumes.

## Contents

- [Fixed blocks](#fixed-blocks)
- [Request form fields, in order](#request-form-fields-in-order)
- [Per line item](#per-line-item)
- [Line description format](#line-description-format)
- [Worked example — Shaw Group](#worked-example--shaw-group)
- [Edge cases](#edge-cases)
- [Source documents](#source-documents)

## Fixed blocks

Use these verbatim. They are **not** the customer-invoice blocks — substituting
those is the single easiest way to produce a wrong PO.

**Bill To (ToolHound):**

```
ToolHound Inc.
2 Bloor Street West
1504
Toronto, ON  M4W 3E2
CA
Ian Wilson
ian.wilson@toolhound.com
```

**Vendor:**

```
Metalcraft USD
3360 9TH ST SW
MASON CITY, IA 50401
US
Jack Ward
jackw@idplate.com
```

## Request form fields, in order

There is no date, payment-terms, or start-date field on the request form. Those
appear on the issued PO after approval, so do not go looking for them.

| Field | Source | Notes |
| --- | --- | --- |
| Who will own the PO | Person raising it | e.g. Ian Wilson |
| Entity | Fixed | `ToolHound Inc.` |
| Message for approvers | Optional | Usually blank |
| Vendor | Fixed | `Metalcraft USD` — selecting it sets currency to USD |
| Memo to Supplier | Compose | `Metalcraft Quotation: {vendor quote no(s)}; Customer PO # {customer PO no}` |
| Ship-to contact | Customer PO ship-to | First name, Last name, Phone country (US +1), Phone (often blank), Email |
| Ship-to address | Customer PO ship-to | Country, Street, Floor/Suite (blank), City, State, Zip — **end customer**, drop-ship |
| Currency | Follows vendor | USD for Metalcraft USD |

## Per line item

One line per label set.

| Field | Source | Notes |
| --- | --- | --- |
| Description | Acknowledgement form | Standardized — see below |
| Quantity | Ack form / customer PO | Must match the ack form's Number of Labels |
| Rate | **Vendor quote** | Metalcraft's cost, not the customer price. Amount auto-calculates and locks |
| NetSuite Category/Inventory Item | Standing default | `506000 - Cost of Goods Sold - Hardware` |
| NetSuite Department | Standing default | `34 - ToolHound` |
| NetSuite Classification | Standing default | `Non-Recurring Revenue - Hardware` |
| NetSuite Division | — | Left blank |
| NetSuite Customer/Job | End customer | e.g. `The Shaw Group` — easy to miss |
| Billable? | Default | `No` |

## Line description format

Single line, semicolon-separated:

```
.002" Premium Poly Pro barcode labels ({width}" x {height}"); {content}; SEQUENCE START: {start}; SEQUENCE END: {end}
```

`{content}` depends on the ack form's "Logo or Text on Labels" field:

- **Graphic logo** → `{Customer Name} logo ({color})`, e.g.
  `Millstone Weber logo (black & white)`. The customer's shorthand is what
  belongs here — `Shaw logo`, not `The Shaw Group logo` — even though
  Customer/Job keeps the full name.
- **Text only** → `TEXT: "{exact text}"`, quotes included literally.

There are no other phrasing variants. No comma-separated form, no
`Sequence start:/end:` wording. The vendor reads this line literally, so
improvising here changes what gets printed.

A full-colour logo carries a 10% surcharge on the customer price per the ack
form. Flag it when selected.

## Worked example — Shaw Group

The script reproduces this exactly given `--size 1.50x0.75`,
`--rate 0.83124 --rate 0.13635`, `--logo-name ToolHound --logo-name Shaw`,
`--quote "257037 & 257038"` and `--customer-po "1700342 OP Rev. 000"`. It is
the regression test for the output format — if a change breaks this, the change
is wrong.

```
Who will own the PO: Ian Wilson
Entity: ToolHound Inc.
Message for approvers: (blank)
Vendor: Metalcraft USD
Memo to Supplier: Metalcraft Quotation: 257037 & 257038; Customer PO # 1700342 OP Rev. 000
Ship-to first name: Juan
Ship-to last name: Lerma
Ship-to phone country: US (+1)
Ship-to phone: (blank)
Ship-to email: jlerma@theshawgrp.com
Ship-to country: United States of America
Ship-to street: 850 Pine St
Ship-to floor/suite: (blank)
Ship-to city: Beaumont
Ship-to state: Texas
Ship-to zip: 77701
Currency: USD
Line 1 description: .002" Premium Poly Pro barcode labels (1.50" x 0.75"); ToolHound logo (black & white); SEQUENCE START: 1; SEQUENCE END: 500
Line 1 quantity: 500
Line 1 rate: 0.83124
Line 1 NetSuite Category/Inventory Item: 506000 - Cost of Goods Sold - Hardware
Line 1 NetSuite Department: 34 - ToolHound
Line 1 NetSuite Classification: Non-Recurring Revenue - Hardware
Line 1 NetSuite Division: (blank)
Line 1 NetSuite Customer/Job: The Shaw Group
Line 1 Billable?: No
Line 2 description: .002" Premium Poly Pro barcode labels (1.50" x 0.75"); Shaw logo (black & white); SEQUENCE START: 501; SEQUENCE END: 5500
Line 2 quantity: 5000
Line 2 rate: 0.13635
Line 2 NetSuite Category/Inventory Item: 506000 - Cost of Goods Sold - Hardware
Line 2 NetSuite Department: 34 - ToolHound
Line 2 NetSuite Classification: Non-Recurring Revenue - Hardware
Line 2 NetSuite Division: (blank)
Line 2 NetSuite Customer/Job: The Shaw Group
Line 2 Billable?: No
PO total (check): 1,097.37 USD
```

## Edge cases

- **Margin inversion.** Vendor cost can exceed the customer price. Shaw's
  ToolHound-logo line cost \$415.62 and billed at \$155.00. Surface it; never
  assume it is intended.
- **Drop-ship.** Ship-to is the end customer, not ToolHound. Correct it if Ramp
  defaults to ToolHound.
- **Sequence and size typos.** The signed acknowledgement form governs specs and
  sequences over the customer PO or a misprinted PO PDF.
- **Line order** may differ between the customer PO and the Metalcraft PO. Match
  by sequence range, not by position.
- **Missing vendor quote** is an expected state. Build the PO with Rate and
  total as `NEEDS INPUT` and report it as pending rather than estimating.

## What the PO history corroborates

Checked against a QuickBooks export of **602 Metalcraft USD purchase orders,
2010-01-04 to 2026-06-24** — the complete label PO history. It is a
header-level export, so it carries no line items, descriptions, quantities or
unit rates, and its Memo column is empty on all but one row. It cannot supply a
vendor rate. What it does settle:

- **Vendor name** is exactly `Metalcraft USD`, on all 602.
- **The COGS default is current practice.** Label POs were coded
  `*Inventory Asset` through 2023, and that coding stops there;
  `*Cost of Goods Sold` appears from 2023 and is the only non-split coding used
  in 2024, 2025 and 2026. So `506000 - Cost of Goods Sold - Hardware` matches
  where this has been heading, rather than contradicting the older records.
- **Typical PO size** is a median near \$600, clustering \$270–\$1,600, with a
  full range of roughly \$200–\$6,300. That range is too wide to police a
  mistyped rate — a tenfold slip lands inside it — so the script checks the
  per-label rate instead, warning outside \$0.01–\$2.00. Known real rates are
  0.13635 and 0.83124.
- **Volume** is 19–48 POs a year, so a handful a month. Low enough that manual
  entry into Ramp is reasonable and there is no case for bulk import.
- **PO numbers are one continuous sequence.** A `DP-` prefix was used until
  2017 (`DP-09709`) and then dropped mid-sequence; the latest is `10406`.
  NetSuite assigns these, so there is nothing to supply.
- **Sales tax is normally zero** — one row in June 2026 carried \$67.40. The
  request form has no tax field anyway.

## Source documents

In the established Linear-driven process, a label order arrives as an issue
titled `[Label Order] submission` and draws on four sources:

| Source | What it provides |
| --- | --- |
| Customer PO to ToolHound | Ship-to details for drop-shipping |
| ToolHound quote to the customer | Quote number, sales rep, currency |
| Signed Label Order Acknowledgement form(s) | Label type, size, adhesive, print colour, logo/text, quantity, sequence start/end |
| Metalcraft / idplate vendor quote (idplate email thread, Jack Ward) | Vendor cost per label, quote numbers for the memo |

Orders coming through the **web form** replace the acknowledgement form for
logo choice, colour, quantity, sequence start, and ship-to — but supply
**neither the label size nor any pricing**. The acknowledgement form or the
vendor quote is still the source for those two.
