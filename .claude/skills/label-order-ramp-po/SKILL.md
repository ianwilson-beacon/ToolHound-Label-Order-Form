---
name: label-order-ramp-po
description: Turn customer label order submissions from the ToolHound label order form into a copy-paste-ready Ramp purchase order for Metalcraft USD. Use this whenever someone asks to raise, build, draft, or prep a Ramp PO, a Metalcraft PO, a vendor PO, or a purchase order for a label order; whenever they reference a label order by its THL- reference, ask "what do I need to order these labels", or want a submitted order turned into something they can put into Ramp or NetSuite. Also use it when asked what is missing or still needed before a label order can be ordered from the vendor, since the web form deliberately omits pricing and label size. Reach for this even when Ramp is not named explicitly — a label order that needs to become a supplier order is this skill's job.
---

# Label order to Ramp PO

Customers authorize label orders through the public form at
`tool-hound-label-order-form.vercel.app`, which writes one row to
`public.label_orders` in the **ToolHound Label Orders** Supabase project
(`ayqcteloqdrlemehozzk`). Staff work those orders on `/admin`.

This skill converts one or more of those rows into the **Metalcraft vendor PO**
— Output 1 of the label order workflow. The customer invoice (Output 2) uses
different pricing and a different billing block and is not this skill's job; if
someone wants that, they want the `toolhound-invoice-prep` skill instead.

## The one thing to get right

The web form is a **thinner input** than the signed acknowledgement form this
process was designed around. It never asks for label size, and it has no idea
what Metalcraft charges. Three fields therefore cannot come from the order:

| Missing | Where it actually comes from |
| --- | --- |
| Label size (width × height) | Signed acknowledgement form, or the Metalcraft quote |
| Rate (vendor cost per label) | Metalcraft's quote **for this order** — the idplate email thread with Jack Ward, `jackw@idplate.com`. Quoted per order, so there is no price list and no previous order to copy from |
| Metalcraft quotation number(s) | Same idplate thread |
| Customer PO number | The customer's own PO document |

Emit these as `NEEDS INPUT` and say so. Never estimate a rate, never infer a
size from the quantity, and never reuse a rate from a previous order —
Metalcraft quotes each order individually, so last time's rate is not a stale
number, it is the wrong one.

A PO with honest blanks gets filled in. One with a plausible-looking wrong
number gets submitted, and becomes a purchasing error nobody catches until the
invoice arrives. A missing vendor quote is a normal, expected state, not a
failure.

## How to run it

**1. Pull the rows.** Query Supabase for the orders in question. Use the
`mcp__Supabase__execute_sql` tool against project `ayqcteloqdrlemehozzk`:

```sql
select order_ref, company_name, contact_name, contact_email,
       address, city, state_province, postal_code, country,
       logo_choice, logo_file_name, text_lines, full_color,
       quantity, start_seq, instructions, status
from public.label_orders
where order_ref in ('THL-...')      -- or: where status = 'received'
order by start_seq;
```

Order by `start_seq` so multiple line items come out in sequence order. Skip
`logo_file_data` — it is megabytes of base64 and nothing here needs it.

**2. Build the block.** Save the returned rows as a JSON array and run:

```bash
python3 .claude/skills/label-order-ramp-po/scripts/build_ramp_po.py \
    --file rows.json \
    --size 1.50x0.75 \
    --rate 0.83124 \
    --quote "257037 & 257038" \
    --customer-po "1700342 OP Rev. 000" \
    --logo-name "Shaw"
```

Pass only the flags you actually have values for. Everything omitted comes out
as `NEEDS INPUT` and appears in a checklist under the block. `--size`, `--rate`
and `--logo-name` repeat per line item; give one value and it applies to every
line.

**3. Hand over the output verbatim.** The script prints the Ramp request form
fields in the order the form asks for them, so they can be worked straight down
the page. Show the whole block, then the checklist. Do not reformat it into a
table or prose — its shape is the point.

Then say plainly what is still outstanding and where each missing piece comes
from. That sentence is the actual deliverable when the vendor quote has not
arrived yet.

## What the script handles that is easy to get wrong

You do not need to redo any of this by hand — but knowing it exists means you
can sanity-check the output:

- **Sequence end** is `start_seq + quantity - 1`. Off-by-one here means the
  vendor prints the wrong range and the labels are scrap.
- **Contact name** splits into first and last on the last space, so multi-word
  first names survive.
- **Address** splits into Street and Floor/Suite only on an unambiguous unit
  keyword. A wrong guess misroutes a shipment, so ambiguous addresses stay in
  Street.
- **Ship-to is the end customer** — this is a drop-ship. If Ramp pre-fills
  ToolHound's own address, that is wrong and needs correcting.
- **Logo wording** follows the acknowledgement form's three shapes exactly,
  because the vendor reads the description literally.

## Judgement calls to raise rather than resolve

The script flags these; your job is to make sure they land rather than
scrolling past:

- **Margin inversion.** Vendor cost has exceeded the customer price on real
  orders — Shaw's ToolHound-logo line cost \$415.62 from Metalcraft and billed
  at \$155.00. The order form carries no customer pricing, so nothing can catch
  this automatically. Surface it; never assume it is intended.
- **Logo naming.** The description uses the customer's shorthand ("Shaw logo"),
  while NetSuite Customer/Job keeps the full legal name ("The Shaw Group"). The
  form only captures whatever the customer typed into Company, so check it.
- **Full colour** carries a 10% surcharge on the customer price. Confirm both
  that the customer invoice reflects it and that the vendor rate quoted is the
  full-colour rate.
- **Sequence starting at 0.** Most runs start at 1. If a customer submitted 0,
  confirm they meant it before ordering.
- **Different customers in one batch.** A Ramp PO carries one vendor and one
  ship-to, so orders for different customers need separate POs.

## Size and sequence

The order form captures neither, and both have varied on real orders:

- **Size** has only ever been `1.50" x 0.75"` or `1.25" x 0.50"`. Anything else
  passes through but gets flagged, since it has to be typed in from the
  acknowledgement form either way.
- **Sequences can be alphanumeric** (`VOL6001 - VOL9000`). `start_seq` is an
  integer column, so pass `--series-prefix VOL`.

Label stock is a single constant, `.002" Premium Poly Pro barcode labels`, as
the Ramp spec names it. Older QuickBooks POs used other stocks and other
wording; that format is superseded and kept only as a historical note in the
reference.

## Fixed values

Vendor is **always Metalcraft USD** for label orders, which sets currency to
USD. The NetSuite coding is standing default on every label PO. All of it lives
in the script's constants, and the full addresses, field-by-field form order,
and the Shaw Group worked example are in
[`references/ramp-po-spec.md`](references/ramp-po-spec.md) — read that when you
need the Bill To / Vendor blocks verbatim, or when something about the form's
field order does not match what you are seeing.

## If asked for a PDF

The established process renders a print-style PDF via `wkhtmltopdf` for Ramp's
own AI pre-fill tool, and attaches it to the source Linear issue. That belongs
to `toolhound-invoice-prep`, which owns the HTML template and the Linear
attachment flow. This skill produces the paste block; if a PDF is wanted, say
so and hand the block over to that skill rather than inventing a second
template.
