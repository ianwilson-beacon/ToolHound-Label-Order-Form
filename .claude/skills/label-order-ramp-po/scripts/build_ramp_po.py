#!/usr/bin/env python3
"""
Turn label_orders rows into a Ramp PO paste block for Metalcraft USD.

Reads the JSON rows a Supabase query returns and emits the Ramp request form
fields in the order the form asks for them, so they can be typed or pasted
straight down the page without hunting for the next value.

The web order form is a thinner input than the signed acknowledgement form this
process was built around: it never asks for label size, and it has no idea what
Metalcraft charges. Rather than guess, anything the form cannot supply is
emitted as NEEDS INPUT and repeated in a checklist at the end. A PO with three
honest blanks is useful; one with three invented numbers is a liability.

Usage:
  # single order, everything the form knows
  supabase-query ... | build_ramp_po.py

  # fill in what the form cannot know
  build_ramp_po.py --file rows.json \\
      --size 1.50x0.75 --rate 0.83124 \\
      --quote "257037 & 257038" --customer-po "1700342 OP Rev. 000"

Multiple rows become multiple line items on one PO. They must be for the same
customer, since a Ramp PO carries one vendor and one ship-to.
"""

import argparse
import json
import re
import sys

NEEDS_INPUT = "NEEDS INPUT"

# Standing defaults for label purchases. These are the same on every label PO,
# which is why they live here rather than being asked for each time.
ENTITY = "ToolHound Inc."
VENDOR = "Metalcraft USD"
CURRENCY = "USD"
NETSUITE_CATEGORY = "506000 - Cost of Goods Sold - Hardware"
NETSUITE_DEPARTMENT = "34 - ToolHound"
NETSUITE_CLASSIFICATION = "Non-Recurring Revenue - Hardware"
NETSUITE_DIVISION = ""          # deliberately blank
BILLABLE = "No"

# Label stock. The Ramp-era spec names one product; the QuickBooks POs actually
# sent in 2024 show at least four, so the stock is a choice rather than a
# constant. Keys are what --stock accepts; values are what the vendor reads.
STOCK_TYPES = {
    "poly": '.002" Premium Poly Pro barcode labels',   # Ramp-era spec wording
    "premium-poly": "Premium Poly Labels",
    "aluminium": "Anodized Aluminium Foil Label, 3 mil",
    "valumark": "ValuMark Polypro Barcode Labels",
}
DEFAULT_STOCK = "poly"

# Sizes seen on real POs. Not a whitelist — an unlisted size is passed through —
# but a size outside this set is worth a second look, since the order form does
# not capture size and it has to be typed in from the acknowledgement form.
KNOWN_SIZES = {("1.50", "0.75"), ("1.25", "0.50")}

# Sanity check on the per-label rate rather than the PO total.
#
# The total is the wrong thing to test: 602 historical Metalcraft POs run from
# roughly $200 to $6,300, so a tenfold rate error still lands inside the range
# (0.83124 typed as 8.3124 gives $4,838, and a real 2025 PO was $6,257). The
# rate itself is far tighter -- poly label costs are cents per label, the known
# real rates being 0.13635 and 0.83124 -- so a rate above a dollar is almost
# certainly a misplaced decimal, and that is catchable where the total is not.
RATE_SUSPICIOUS_ABOVE = 2.00
RATE_SUSPICIOUS_BELOW = 0.01

# Ramp's ship-to country field wants the long form.
COUNTRY_LONG = {
    "us": "United States of America",
    "usa": "United States of America",
    "united states": "United States of America",
    "united states of america": "United States of America",
    "ca": "Canada",
    "canada": "Canada",
}

# Ramp's phone country selector is a separate field from the number.
PHONE_COUNTRY = {
    "United States of America": "US (+1)",
    "Canada": "CA (+1)",
}


def split_contact_name(full_name):
    """
    The web form collects one contact name; Ramp wants first and last
    separately. Split on the last space so multi-word first names survive
    ("Mary Jane Watson" -> "Mary Jane" / "Watson").
    """
    parts = (full_name or "").strip().split()
    if not parts:
        return NEEDS_INPUT, NEEDS_INPUT
    if len(parts) == 1:
        return parts[0], NEEDS_INPUT
    return " ".join(parts[:-1]), parts[-1]


def split_street(address):
    """
    Ramp has separate Street and Floor/Suite fields; the form has one address
    box. Pull a trailing unit designator out if the customer typed one, and
    leave both parts alone otherwise — a wrong guess here misroutes a shipment,
    so only split on an unambiguous keyword.
    """
    raw = (address or "").strip()
    if not raw:
        return NEEDS_INPUT, ""
    m = re.search(
        r",\s*((?:suite|ste\.?|unit|apt\.?|apartment|floor|fl\.?|#)\s*[\w-]+)\s*$",
        raw,
        re.IGNORECASE,
    )
    if m:
        return raw[: m.start()].strip().rstrip(","), m.group(1).strip()
    return raw, ""


def normalize_country(country):
    key = (country or "").strip().lower()
    return COUNTRY_LONG.get(key, (country or "").strip() or NEEDS_INPUT)


def parse_size(size):
    """Accept 1.50x0.75, 1.5 x .75, or 1.50" x 0.75" and normalize to 2dp."""
    if not size:
        return None
    nums = re.findall(r"\d*\.?\d+", str(size))
    if len(nums) != 2:
        return None
    return f"{float(nums[0]):.2f}", f"{float(nums[1]):.2f}"


def label_content(row, flags, logo_name=None):
    """
    Render the middle segment of the line description from the logo choice.

    The three shapes come from the acknowledgement form's "Logo or Text on
    Labels" field, and the vendor reads this literally, so the wording is not
    ours to improvise.
    """
    choice = (row.get("logo_choice") or "").strip()
    full_colour = (row.get("full_color") or "").strip().lower() == "yes"
    colour = "full colour" if full_colour else "black & white"

    if full_colour:
        flags.append(
            "Full-colour logo selected — carries a 10% surcharge on the customer "
            "price per the acknowledgement form. Confirm it is reflected in the "
            "customer invoice (Output 2), and confirm the vendor rate is the "
            "full-colour rate."
        )

    if choice == "toolhound_logo":
        return f"ToolHound logo ({colour})"

    if choice == "custom_logo":
        if logo_name:
            return f"{logo_name} logo ({colour})"
        company = (row.get("company_name") or "").strip() or NEEDS_INPUT
        # The vendor reads this line, and the customer's own shorthand is what
        # belongs on the label: the Shaw Group order shipped as "Shaw logo", not
        # "The Shaw Group logo", even though Customer/Job stayed the full name.
        # The form only captures whatever the customer typed into Company, so
        # this is worth an eyeball every time rather than a silent guess.
        flags.append(
            f"{row.get('order_ref')}: logo described as \"{company} logo\" from the "
            "Company field. If they go by a shorter name on the label (\"The Shaw "
            "Group\" -> \"Shaw\"), re-run with --logo-name. Customer/Job keeps the "
            "full name either way."
        )
        return f"{company} logo ({colour})"

    if choice == "custom_text":
        lines = [str(t).strip() for t in (row.get("text_lines") or []) if str(t).strip()]
        if not lines:
            flags.append(
                f"{row.get('order_ref')}: logo choice is custom_text but no text "
                "lines were submitted. Check the order before ordering."
            )
            return f'TEXT: "{NEEDS_INPUT}"'
        if len(lines) > 1:
            flags.append(
                f"{row.get('order_ref')}: customer submitted {len(lines)} text "
                f"lines ({' / '.join(lines)}). They are joined with ' / ' here — "
                "confirm how Metalcraft should stack them on the label."
            )
        return 'TEXT: "' + " / ".join(lines) + '"'

    flags.append(f"{row.get('order_ref')}: unrecognised logo choice {choice!r}.")
    return NEEDS_INPUT


def line_description(row, size, flags, logo_name=None, stock=None, series_prefix=None):
    stock_text = STOCK_TYPES.get(stock or DEFAULT_STOCK, stock or STOCK_TYPES[DEFAULT_STOCK])
    if not stock:
        flags.append(
            f"{row.get('order_ref')}: label stock assumed to be "
            f"\"{STOCK_TYPES[DEFAULT_STOCK]}\". Real orders have also used Premium "
            "Poly Labels, Anodized Aluminium Foil (3 mil) and ValuMark Polypro "
            "(incl. white-on-red). The order form does not capture stock, so "
            "confirm it against the acknowledgement form and pass --stock "
            "premium-poly|aluminium|valumark if it differs."
        )

    parsed = parse_size(size)
    if parsed:
        dims = f'({parsed[0]}" x {parsed[1]}")'
        if parsed not in KNOWN_SIZES:
            flags.append(
                f"{row.get('order_ref')}: size {parsed[0]}\" x {parsed[1]}\" is not "
                "one seen on past POs (1.50 x 0.75 and 1.25 x 0.50). Double-check "
                "it against the acknowledgement form."
            )
    else:
        dims = f'({NEEDS_INPUT}" x {NEEDS_INPUT}")'
        flags.append(
            f"{row.get('order_ref')}: label size is not captured by the web order "
            "form. Take the dimensions from the signed acknowledgement form or the "
            "Metalcraft quote and re-run with --size."
        )

    qty = row.get("quantity")
    start = row.get("start_seq")
    if series_prefix:
        # Real POs have carried alphanumeric series (VOL6001 - VOL9000). The
        # order form stores start_seq as an integer and cannot express that, so
        # the prefix is supplied here and applied to both ends.
        flags.append(
            f"{row.get('order_ref')}: series prefix {series_prefix!r} applied — the "
            "order form stores the sequence as a plain number, so this came from "
            "you rather than the customer. Confirm it matches the acknowledgement "
            "form."
        )
    if isinstance(qty, int) and isinstance(start, int) and qty > 0:
        end = start + qty - 1
        if start == 0:
            flags.append(
                f"{row.get('order_ref')}: sequence starts at 0, so the range is "
                f"0–{end} rather than 1–{qty}. Confirm the customer meant 0 — most "
                "runs start at 1."
            )
    else:
        end = NEEDS_INPUT

    content = label_content(row, flags, logo_name)
    s_start = f"{series_prefix}{start}" if series_prefix else start
    s_end = f"{series_prefix}{end}" if series_prefix and end != NEEDS_INPUT else end
    return (
        f"{stock_text} {dims}; {content}; "
        f"SEQUENCE START: {s_start}; SEQUENCE END: {s_end}"
    )


def build(rows, opts):
    flags = []
    out = []

    first = rows[0]
    companies = {(r.get("company_name") or "").strip() for r in rows}
    if len(companies) > 1:
        flags.append(
            "Rows are for different customers ("
            + ", ".join(sorted(companies))
            + "). A Ramp PO carries one vendor and one ship-to, so these need "
            "separate POs. Only the first customer's ship-to is shown below."
        )

    country = normalize_country(first.get("country"))
    street, suite = split_street(first.get("address"))
    firstname, lastname = split_contact_name(first.get("contact_name"))

    quote = opts.quote or NEEDS_INPUT
    customer_po = opts.customer_po or NEEDS_INPUT
    memo = f"Metalcraft Quotation: {quote}; Customer PO # {customer_po}"
    if not opts.quote:
        flags.append(
            "Metalcraft quotation number is missing. It comes from the idplate "
            "email thread (Jack Ward, jackw@idplate.com), not the order form. "
            "Drop that segment of the memo if the quote has not come back yet."
        )
    if not opts.customer_po:
        flags.append(
            "Customer PO number is missing. The web order form does not collect "
            "it — take it from the customer's PO document."
        )

    out.append(f"Who will own the PO: {opts.owner}")
    out.append(f"Entity: {ENTITY}")
    out.append("Message for approvers: (blank)")
    out.append(f"Vendor: {VENDOR}")
    out.append(f"Memo to Supplier: {memo}")
    out.append(f"Ship-to first name: {firstname}")
    out.append(f"Ship-to last name: {lastname}")
    out.append(f"Ship-to phone country: {PHONE_COUNTRY.get(country, NEEDS_INPUT)}")
    out.append("Ship-to phone: (blank)")
    out.append(f"Ship-to email: {first.get('contact_email') or NEEDS_INPUT}")
    out.append(f"Ship-to country: {country}")
    out.append(f"Ship-to street: {street}")
    out.append(f"Ship-to floor/suite: {suite or '(blank)'}")
    out.append(f"Ship-to city: {first.get('city') or NEEDS_INPUT}")
    out.append(f"Ship-to state: {first.get('state_province') or NEEDS_INPUT}")
    out.append(f"Ship-to zip: {first.get('postal_code') or NEEDS_INPUT}")
    out.append(f"Currency: {CURRENCY}")

    total = 0.0
    total_known = True

    for i, row in enumerate(rows, start=1):
        ref = row.get("order_ref") or f"row {i}"
        size = opts.size_for(ref, i)
        rate = opts.rate_for(ref, i)
        qty = row.get("quantity")

        out.append(
            f"Line {i} description: "
            f"{line_description(row, size, flags, opts.logo_name_for(ref, i), opts.stock_for(ref, i), opts.series_prefix_for(ref, i))}"
        )
        out.append(f"Line {i} quantity: {qty if qty is not None else NEEDS_INPUT}")
        if rate is None:
            out.append(f"Line {i} rate: {NEEDS_INPUT}")
            total_known = False
            flags.append(
                f"{ref}: vendor rate is missing. It is Metalcraft's cost per label "
                "from their quote — never the customer price, and never an "
                "estimate. Re-run with --rate once the quote arrives."
            )
        else:
            out.append(f"Line {i} rate: {rate}")
            if rate > RATE_SUSPICIOUS_ABOVE or rate < RATE_SUSPICIOUS_BELOW:
                flags.append(
                    f"{ref}: rate of {rate} per label is outside the cents-per-label "
                    "range these cost (real rates have been 0.13635 and 0.83124). "
                    "Check the decimal place — the PO total will look plausible "
                    "either way, so this is the only place the slip shows."
                )
            if isinstance(qty, int):
                total += rate * qty
            else:
                total_known = False
        out.append(f"Line {i} NetSuite Category/Inventory Item: {NETSUITE_CATEGORY}")
        out.append(f"Line {i} NetSuite Department: {NETSUITE_DEPARTMENT}")
        out.append(f"Line {i} NetSuite Classification: {NETSUITE_CLASSIFICATION}")
        out.append(f"Line {i} NetSuite Division: (blank)")
        out.append(
            f"Line {i} NetSuite Customer/Job: "
            f"{(row.get('company_name') or '').strip() or NEEDS_INPUT}"
        )
        out.append(f"Line {i} Billable?: {BILLABLE}")

    if total_known:
        out.append(f"PO total (check): {total:,.2f} {CURRENCY}")
        flags.append(
            "Compare each line's vendor cost against what the customer is being "
            "billed before submitting. Vendor cost has exceeded the customer "
            "price on real orders (Shaw's ToolHound-logo line cost $415.62 and "
            "billed at $155.00), and the order form carries no customer pricing, "
            "so nothing here can catch that for you."
        )
    else:
        out.append(f"PO total (check): {NEEDS_INPUT}")

    return "\n".join(out), flags


class Opts:
    """Per-line overrides, either one value for every line or line-indexed."""

    def __init__(self, args):
        self.owner = args.owner
        self.quote = args.quote
        self.customer_po = args.customer_po
        self._sizes = self._index(args.size)
        self._logo_names = self._index(args.logo_name)
        self._stocks = self._index(args.stock)
        self._prefixes = self._index(args.series_prefix)
        self._rates = self._index(args.rate, cast=float)

    @staticmethod
    def _index(values, cast=str):
        """--size 1.5x0.75 applies to all lines; repeat the flag per line to differ."""
        if not values:
            return []
        return [cast(v) if cast is not str else v for v in values]

    def size_for(self, ref, i):
        if not self._sizes:
            return None
        return self._sizes[i - 1] if len(self._sizes) >= i else self._sizes[0]

    def rate_for(self, ref, i):
        if not self._rates:
            return None
        return self._rates[i - 1] if len(self._rates) >= i else self._rates[0]

    def logo_name_for(self, ref, i):
        return self._pick(self._logo_names, i)

    def stock_for(self, ref, i):
        return self._pick(self._stocks, i)

    def series_prefix_for(self, ref, i):
        return self._pick(self._prefixes, i)

    @staticmethod
    def _pick(values, i):
        if not values:
            return None
        return values[i - 1] if len(values) >= i else values[0]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--file", help="JSON file of label_orders rows (default: stdin)")
    p.add_argument("--owner", default="Ian Wilson", help="Who will own the PO")
    p.add_argument("--quote", help="Metalcraft quotation number(s) for the memo")
    p.add_argument("--customer-po", dest="customer_po", help="Customer PO number for the memo")
    p.add_argument("--size", action="append",
                   help='Label size, e.g. 1.50x0.75. Repeat per line item.')
    p.add_argument("--rate", action="append",
                   help="Vendor cost per label. Repeat per line item.")
    p.add_argument("--stock", action="append",
                   choices=sorted(STOCK_TYPES),
                   help="Label stock. Defaults to %(default)s. Repeat per line item.")
    p.add_argument("--series-prefix", dest="series_prefix", action="append",
                   help='Alphanumeric sequence prefix, e.g. VOL. Repeat per line item.')
    p.add_argument("--logo-name", dest="logo_name", action="append",
                   help='Customer name as it should read on the label, e.g. "Shaw". '
                        "Defaults to the Company field. Repeat per line item.")
    args = p.parse_args()

    raw = open(args.file).read() if args.file else sys.stdin.read()
    data = json.loads(raw)
    rows = data if isinstance(data, list) else [data]
    if not rows:
        sys.exit("No rows given.")

    block, flags = build(rows, Opts(args))

    print("=== RAMP PO — paste into the request form, top to bottom ===\n")
    print(block)

    if flags:
        print("\n=== BEFORE YOU SUBMIT ===\n")
        for f in flags:
            print(f"- {f}")
    else:
        print("\nNo gaps: every field came from the order or a standing default.")


if __name__ == "__main__":
    main()
