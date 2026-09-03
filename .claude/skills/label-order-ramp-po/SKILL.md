---
name: label-order-ramp-po
description: Turn customer label order submissions from the ToolHound label order form into a copy-paste-ready Ramp purchase order for Metalcraft USD. Use this whenever someone asks to raise, build, draft, or prep a Ramp PO, a Metalcraft PO, a vendor PO, or a purchase order for a label order; whenever they reference a label order by its THL- reference, ask "what do I need to order these labels", or want a submitted order turned into something they can put into Ramp or NetSuite. Also use it when asked what is missing or still needed before a label order can be ordered from the vendor, since a label PO is raised at 0.00 per unit before Metalcraft invoices. Reach for this even when Ramp is not named explicitly — a label order that needs to become a supplier order is this skill's job.
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

**Label POs go to Metalcraft at 0.00 per unit.** They do not invoice until they
have the PO, so the price genuinely is not known when it is raised. The
quantity and the line description are what the PO communicates; the money
follows on their invoice.

An empty rate is therefore not a gap to chase. The script writes `0.00` and
says why. Do not hunt for a quotation number that does not exist yet, and do
not put a placeholder in the memo — a PO reading `Metalcraft Quotation: NEEDS
INPUT` reaches the vendor looking like a mistake, so that segment is dropped
and the memo carries the customer PO alone.

When a quote **does** exist — occasionally one is obtained upfront to price a
customer quote, as on the Shaw order — pass `--rate` and `--quote` and the PO
totals normally.

The order form supplies label size, the sequence as typed, customer PO,
delivery phone and receiving contact, so a current order needs nothing added. Orders
placed before those fields existed have no size; that one is worth saying, and
it comes off the signed acknowledgement form.

## How to run it

**1. Get the order data.** Two ways in, and the first is usually already done
for you:

*The dashboard file.* Every order on `/admin` has a **Download PO inputs**
button in its detail drawer, producing `<order_ref>-ramp-po-input.json`. If
someone has handed you that file, use it — it already holds every field this
needs, and no database access is required.

*Or query Supabase* with `mcp__Supabase__execute_sql` against project
`ayqcteloqdrlemehozzk`:

```sql
select order_ref, company_name, contact_name, contact_email,
       address, city, state_province, postal_code, country,
       attention_name, ship_to_phone, customer_po,
       logo_choice, logo_file_name, text_lines, full_color,
       label_width_in, label_height_in,
       quantity, seq_start, start_seq, instructions, status
from public.label_orders
where order_ref in ('THL-...')      -- or: where status = 'received'
order by seq_start;
```

Order by `seq_start` so multiple line items come out in sequence order. Skip
`logo_file_data` — it is megabytes of base64 and nothing here needs it.

**2. Build the block.** Point the script at the file either way:

```bash
python3 .claude/skills/label-order-ramp-po/scripts/build_ramp_po.py \
    --file THL-MTKE78Z7-Z9GAB4-ramp-po-input.json
```

That is the whole command for a normal order. Add `--rate` and `--quote` only
in the uncommon case where Metalcraft has already quoted.

It reads the dashboard's wrapped file, a plain array of rows, or a single row
object. Size, sequence, customer PO, phone and receiving contact all come off
the order. `--size`,
`--seq-start`, `--customer-po` and `--logo-name` are overrides for an older
order that lacks them, or for a correction. Anything still unknown comes out as
`NEEDS INPUT` with a checklist under the block. Repeatable flags apply per line
item; give one value and it applies to every line.

**One PO, several label sets?** The order form takes one set per submission, so
a customer wanting two gets two `THL-` references. Download both files and pass
the orders together — the script makes them separate line items on one PO, as
long as they are the same customer.

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

- **Sequence end** increments the trailing digits of `seq_start` by
  `quantity - 1` and re-pads to the same width. Off-by-one here, or dropped
  padding, means the vendor prints the wrong range and the labels are scrap.
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

- **Margin inversion**, but only once Metalcraft's invoice arrives. Their cost
  has exceeded the customer price on real orders — Shaw's ToolHound-logo line
  cost \$415.62 and billed at \$155.00. Nothing at PO time can catch that, since
  the PO carries no price; it is a check for whoever reconciles the invoice.
- **Logo naming.** The description uses the customer's shorthand ("Shaw logo"),
  while NetSuite Customer/Job keeps the full legal name ("The Shaw Group"). The
  form only captures whatever the customer typed into Company, so check it.
- **Full colour** carries a 10% surcharge on the customer price. Confirm both
  that the customer invoice reflects it and that the vendor rate quoted is the
  full-colour rate.
- **Sequence starting at 0.** Most runs start at 1 or 0001. If a customer
  submitted 0, confirm they meant it before ordering.
- **NetSuite Customer/Job.** It is whatever the customer typed into Company,
  and it has to match a NetSuite record. Real orders have arrived under the
  wrong entity and under one that did not exist in NetSuite at all — a PCL
  Nisku order filed as PCL Arizona, where Nisku was not yet a customer. Neither
  is detectable from the order, so the script names it once per PO for you to
  confirm.
- **Different customers in one batch.** A Ramp PO carries one vendor and one
  ship-to, so orders for different customers need separate POs.

## Size and sequence

Both now come from the order, and the script prefers the row over a flag:

- **Size** is a choice of `1.50" x 0.75"` or `1.25" x 0.50"` — the only two
  ever ordered — plus a free entry. A size outside those two is flagged.
- **Sequence** is one string, stored exactly as the customer typed it, because
  the signed acknowledgement form governs it and real forms read `TSG-0001`,
  `1515000`, `VOL6001`. A prefix-plus-integer model cannot express those: it
  renders `TSG-0001` as `TSG1`, and the vendor prints the description
  literally, so that is simply the wrong label.

  The end of the range is still derived rather than asked for twice — take the
  trailing run of digits, add quantity - 1, re-pad to the same width. `TSG-0001`
  over 500 gives `TSG-0500`; `10000` over 5000 gives `14999`. A sequence with no
  trailing digits cannot describe a range and is flagged.

  Older orders that predate this carry the legacy `start_seq` integer; the
  script falls back to it, and `--seq-start` overrides either.

Label stock is a single constant, `.002" Premium Poly Pro barcode labels`, as
the Ramp spec names it.

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
