#!/usr/bin/env python3
"""
Turn a build_ramp_po.py paste block into the print-style PDF Ian uploads to Ramp.

Ramp's "upload an order form to pre-fill your request" tool reads the PDF with
its own parser, so the only thing that matters is that the label/value rows
survive as plain text in the right order. The layout exists to be parsed, not
admired.

`toolhound-invoice-prep` owns the house style this reproduces (see its
assets/ramp-po-print.example.html) and its own renderer shells out to
wkhtmltopdf. That binary is not present in every environment this runs in, so
this script drives the Chromium that Playwright already installs instead, and
verifies the extraction with pypdf rather than pdftotext. Same document, same
field order, one less dependency.

Usage:
  render_po_pdf.py SALES-161-...-ramp-po.txt --title "Millstone Weber" \
      --out SALES-161-millstone-weber-metalcraft-po.pdf
"""

import argparse
import html
import os
import re
import shutil
import subprocess
import sys
import tempfile

# The Ramp form groups its fields under these headings, and the PDF has to
# follow the same order or the parser fills the wrong boxes. Each entry is a
# heading and the block-field prefixes that belong under it.
SECTIONS = [
    ("Who is this for?", [
        "Who will own the PO", "Entity", "Message for approvers",
        "Vendor", "Memo to Supplier",
    ]),
    ("Ship-to contact", [
        "Ship-to first name", "Ship-to last name",
        "Ship-to phone country", "Ship-to phone", "Ship-to email",
    ]),
    ("Ship-to address", [
        "Ship-to country", "Ship-to street", "Ship-to floor/suite",
        "Ship-to city", "Ship-to state", "Ship-to zip", "Currency",
    ]),
]

# Field names as the Ramp form words them, which is not always how the paste
# block words them. The block is written to be read down a screen; the PDF is
# written to be read by Ramp.
RENAME = {
    "Ship-to first name": "First name",
    "Ship-to last name": "Last name",
    "Ship-to phone country": "Phone country",
    "Ship-to phone": "Phone",
    "Ship-to email": "Email",
    "Ship-to country": "Country",
    "Ship-to street": "Street address",
    "Ship-to floor/suite": "Floor / Suite / Office #",
    "Ship-to city": "City",
    "Ship-to state": "State",
    "Ship-to zip": "Zip code",
}

CSS = """
  @page{margin:28px 34px;}
  *{box-sizing:border-box;}
  body{font-family:Helvetica,Arial,sans-serif;color:#1c1b19;margin:0;font-size:11px;}
  h1{font-size:17px;font-weight:700;margin:0 0 2px;}
  .sub0{font-size:11px;color:#6f6e66;margin:0 0 14px;}
  .hd{font-size:13px;font-weight:700;margin:14px 0 6px;padding-top:8px;border-top:1px solid #d9d7cf;}
  .hd:first-of-type{border-top:none;padding-top:0;margin-top:0;}
  table{width:100%;border-collapse:collapse;margin-bottom:2px;}
  td{padding:3px 0;font-size:11px;vertical-align:top;border-bottom:1px solid #f0eee8;}
  td.l{width:190px;color:#6f6e66;}
  td.v{color:#1c1b19;font-family:"Courier New",monospace;}
  td.v.skip{font-family:Helvetica,Arial,sans-serif;color:#9a988f;font-style:italic;}
  td.v.gap{font-family:Helvetica,Arial,sans-serif;color:#8a1f11;font-weight:700;}
  .lineno{font-size:11px;font-weight:700;margin:10px 0 3px;}
  .foot{font-size:10px;color:#9a988f;margin-top:10px;}
"""


def parse_block(text):
    """Pull the 'Field: value' rows out of the paste block, in order."""
    fields, total = [], None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("==="):
            continue
        if line.startswith("- "):      # the checklist, not a field
            continue
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        name, value = name.strip(), value.strip()
        if name.startswith("PO total"):
            total = value
            continue
        fields.append((name, value))
    return fields, total


def row(label, value):
    cls = "v"
    if value == "(blank)":
        cls = "v skip"
        value = "(leave blank)"
    elif "NEEDS INPUT" in value:
        cls = "v gap"
    return (f'<tr><td class="l">{html.escape(label)}</td>'
            f'<td class="{cls}">{html.escape(value)}</td></tr>')


def build_html(title, fields, total):
    by_name = dict(fields)
    used = set()
    out = [
        "<!DOCTYPE html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
        f"<title>{html.escape(title)} — Metalcraft PO (Ramp)</title>",
        f"<style>{CSS}</style>", "</head>", "<body>",
        f"<h1>{html.escape(title)} — Metalcraft PO</h1>",
        '<p class="sub0">Ramp request form — fields in the order the form asks for them</p>',
    ]

    for heading, names in SECTIONS:
        rows = []
        for name in names:
            if name in by_name:
                used.add(name)
                rows.append(row(RENAME.get(name, name), by_name[name]))
        if rows:
            out.append(f'<p class="hd">{html.escape(heading)}</p>')
            out.append("<table>" + "".join(rows) + "</table>")

    # Line items keep the block's own order, since a PO can carry several and
    # they have to stay in sequence order.
    lines = {}
    for name, value in fields:
        m = re.match(r"^Line (\d+) (.+)$", name)
        if not m:
            continue
        used.add(name)
        # The block writes "Line 1 description"; the Ramp form says
        # "Description". Only the first letter differs, and only for the
        # lower-cased ones the block generates.
        label = m.group(2)
        label = label[:1].upper() + label[1:]
        lines.setdefault(m.group(1), []).append((label, value))

    for n in sorted(lines, key=int):
        out.append(f'<p class="lineno">How much? — Line {n}</p>')
        out.append("<table>" + "".join(row(l, v) for l, v in lines[n]) + "</table>")

    leftover = [(n, v) for n, v in fields if n not in used]
    if leftover:
        out.append('<p class="hd">Other</p>')
        out.append("<table>" + "".join(row(n, v) for n, v in leftover) + "</table>")

    if total:
        out.append('<p class="foot">PO total for a final check before Request: '
                   f"{html.escape(total)}.</p>")
    out += ["</body>", "</html>"]
    return "\n".join(out)


def find_chromium():
    for path in ("/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
                 "/opt/pw-browsers/chromium/chrome-linux/chrome"):
        if os.path.exists(path):
            return path
    for name in ("chromium", "chromium-browser", "google-chrome"):
        found = shutil.which(name)
        if found:
            return found
    import glob
    hits = sorted(glob.glob("/opt/pw-browsers/chromium*/chrome-linux/chrome"))
    if hits:
        return hits[-1]
    sys.exit("no Chromium found to render the PDF")


def render(src_html, out_pdf):
    subprocess.run([
        find_chromium(), "--headless", "--no-sandbox", "--disable-gpu",
        "--no-pdf-header-footer", f"--print-to-pdf={out_pdf}",
        "file://" + os.path.abspath(src_html),
    ], check=True, capture_output=True)
    if not os.path.exists(out_pdf) or os.path.getsize(out_pdf) == 0:
        sys.exit("Chromium produced an empty PDF")


def verify(out_pdf):
    """Print what Ramp's parser will see, then check the fields it keys off."""
    from pypdf import PdfReader
    text = "\n".join(p.extract_text() or "" for p in PdfReader(out_pdf).pages)
    print("--- extracted text (this is what Ramp's parser sees) ---")
    print(text)
    for needle in ("Vendor", "Memo to Supplier", "Currency", "Quantity", "Rate"):
        if needle.lower() not in text.lower():
            print(f"WARNING: {needle!r} not found in the extracted text", file=sys.stderr)
    if "NEEDS INPUT" in text:
        print("WARNING: a NEEDS INPUT gap is still in the document — Ramp will "
              "pre-fill that literal string. Fill it before uploading.",
              file=sys.stderr)
    if "{" in text:
        print("WARNING: an unfilled {placeholder} is still in the document",
              file=sys.stderr)


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("block", help="paste block from build_ramp_po.py")
    p.add_argument("--title", required=True, help="customer name for the heading")
    p.add_argument("--out", required=True, help="output PDF path")
    p.add_argument("--keep-html", help="also write the intermediate HTML here")
    args = p.parse_args()

    with open(args.block, encoding="utf-8") as fh:
        fields, total = parse_block(fh.read())
    if not fields:
        sys.exit(f"no fields parsed out of {args.block}")

    doc = build_html(args.title, fields, total)
    target = args.keep_html or os.path.join(tempfile.mkdtemp(), "po.html")
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(doc)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    render(target, args.out)
    print(f"wrote {args.out} ({os.path.getsize(args.out)} bytes)\n")
    verify(args.out)


if __name__ == "__main__":
    main()
