#!/usr/bin/env bash
# Regression test: the Shaw Group order must reproduce the known-good PO exactly.
# The vendor reads the line descriptions literally, so format drift is a real
# defect, not a cosmetic one.
set -uo pipefail
cd "$(dirname "$0")"
fail=0

got=$(python3 ../scripts/build_ramp_po.py --file shaw_rows.json \
        --quote "257037 & 257038" --customer-po "1700342 OP Rev. 000" \
        --size 1.50x0.75 --rate 0.83124 --rate 0.13635 \
        --logo-name "ToolHound" --logo-name "Shaw" \
      | sed -n '/^Who will own the PO:/,/^PO total/p')

if diff -u shaw_expected.txt <(printf '%s\n' "$got") >/dev/null; then
  echo "PASS  Shaw Group example reproduced exactly"
else
  echo "FAIL  Shaw Group example drifted:"
  diff -u shaw_expected.txt <(printf '%s\n' "$got") | sed 's/^/      /'
  fail=1
fi

# The normal case: no Metalcraft quote exists yet, because they do not invoice
# until they have the PO. Rates go out at 0.00 and the quotation segment is
# dropped from the memo rather than filled with a placeholder.
bare=$(python3 ../scripts/build_ramp_po.py --file shaw_rows.json)
for want in "Line 1 rate: 0.00" "PO total (check): 0.00 USD" \
            "Metalcraft invoices after they receive the PO"; do
  if grep -qF "$want" <<<"$bare"; then
    echo "PASS  zero-rate PO is the normal case: $want"
  else
    echo "FAIL  zero-rate PO not handled: $want"
    fail=1
  fi
done

# A placeholder in the memo would reach the vendor looking like a mistake.
for unwanted in "Metalcraft Quotation: NEEDS INPUT" "Line 1 rate: NEEDS INPUT" \
                "PO total (check): NEEDS INPUT" "vendor rate is missing"; do
  if grep -qF "$unwanted" <<<"$bare"; then
    echo "FAIL  chases a value that does not exist yet: $unwanted"
    fail=1
  else
    echo "PASS  does not chase a nonexistent value: $unwanted"
  fi
done

# Size genuinely is missing on a pre-0008 order, and that one is worth saying.
if grep -qF "no label size on the order" <<<"$bare"; then
  echo "PASS  missing input surfaced: no label size on the order"
else
  echo "FAIL  missing input NOT surfaced: no label size on the order"
  fail=1
fi

# An order carrying the fields the form now asks for should need no flags for
# them, and should route the shipment to the receiving contact rather than the
# person who placed the order.
supplied=$(python3 ../scripts/build_ramp_po.py --file row_supplied.json --rate 0.14 --quote Q9)
for want in 'Line 1 description: .002" Premium Poly Pro barcode labels (1.25" x 0.50")' \
            "SEQUENCE START: VOL6001; SEQUENCE END: VOL9000" \
            "Customer PO # 4500620115" \
            "Ship-to phone: 204-555-0117" \
            "Ship-to first name: Mike" \
            "Ship-to last name: Betts" \
            "Ship-to floor/suite: Unit A"; do
  if grep -qF "$want" <<<"$supplied"; then
    echo "PASS  taken from the order row: $want"
  else
    echo "FAIL  NOT taken from the order row: $want"
    fail=1
  fi
done

# And none of those should still be asking for input.
for unwanted in "no label size on the order" "No customer PO number" \
                "came from the command line"; do
  if grep -qF "$unwanted" <<<"$supplied"; then
    echo "FAIL  still flagged despite being on the order: $unwanted"
    fail=1
  else
    echo "PASS  not flagged, the order supplied it: $unwanted"
  fi
done

# The dashboard's download button and this script are two halves of one
# workflow, so the file it emits has to parse here without editing.
dl=$(python3 ../scripts/build_ramp_po.py --file dashboard_download.json --rate 0.14 --quote Q9)
# And the same order the way it is normally raised, with no quote at all.
dl0=$(python3 ../scripts/build_ramp_po.py --file dashboard_download.json)
if grep -qF "Memo to Supplier: Customer PO # 4500620115" <<<"$dl0"; then
  echo "PASS  memo drops the quotation segment when there is no quote"
else
  echo "FAIL  memo did not drop the quotation segment"
  fail=1
fi

# Millstone Weber issued no customer PO at all, and plenty of customers never
# do. A memo reading "Customer PO # NEEDS INPUT" would reach Metalcraft looking
# like a mistake, exactly as the quotation placeholder would, so the segment is
# dropped and the memo goes out blank.
nopo=$(python3 ../scripts/build_ramp_po.py --file shaw_rows.json)
if grep -qF "Memo to Supplier: (blank)" <<<"$nopo" \
   && ! grep -qF "Customer PO # NEEDS INPUT" <<<"$nopo"; then
  echo "PASS  memo goes out blank rather than carrying a customer-PO placeholder"
else
  echo "FAIL  memo shipped a NEEDS INPUT customer PO to the vendor"
  fail=1
fi

# Metalcraft reads the memo, so an instruction about how the labels are made
# has to travel with the PO. The order form's Special Instructions come along
# automatically; --vendor-note carries one off the acknowledgement form.
note=$(python3 ../scripts/build_ramp_po.py --file dashboard_download.json \
        --vendor-note "Red background with white print")
if grep -qF "Customer PO # 4500620115; Red background with white print" <<<"$note"; then
  echo "PASS  a vendor instruction rides in the memo behind the PO reference"
else
  echo "FAIL  vendor instruction did not reach the memo"
  fail=1
fi
if grep -qF "check it says what the labels need and nothing internal" <<<"$note"; then
  echo "PASS  a memo carrying instructions is flagged for an eyeball"
else
  echo "FAIL  memo instructions went unflagged"
  fail=1
fi

# A text label is printed in a colour as much as a logo one is, and the vendor
# reads the description literally. Diavik's 2027 labels are red on white.
col=$(python3 ../scripts/build_ramp_po.py --file dashboard_download.json)
if grep -qE 'TEXT: "AECON" \((black & white|full colour)\)' <<<"$col"; then
  echo "PASS  a text label states its colour like a logo line does"
else
  echo "FAIL  text label description dropped the colour"
  fail=1
fi
for want in 'Line 1 description: .002" Premium Poly Pro barcode labels (1.25" x 0.50")' \
            "SEQUENCE START: VOL6001; SEQUENCE END: VOL9000" \
            "Customer PO # 4500620115" \
            "Ship-to first name: Mike" \
            "PO total (check): 420.00 USD"; do
  if grep -qF "$want" <<<"$dl"; then
    echo "PASS  dashboard download parsed: $want"
  else
    echo "FAIL  dashboard download NOT parsed: $want"
    fail=1
  fi
done

# Customer/Job is named once per PO, not once per line -- two line items for
# one customer should not produce the same warning twice.
two_line=$(python3 ../scripts/build_ramp_po.py --file shaw_rows.json \
             --size 1.50x0.75 --rate 0.83124 --rate 0.13635 \
             --logo-name ToolHound --logo-name Shaw --quote Q --customer-po P)
n=$(grep -c "NetSuite Customer/Job reads" <<<"$two_line")
if [ "$n" = "1" ]; then
  echo "PASS  Customer/Job flagged once per PO, not once per line"
else
  echo "FAIL  Customer/Job flagged $n times across 2 lines, expected 1"
  fail=1
fi

# Vendor and currency are fixed for label orders.
for want in "Vendor: Metalcraft USD" "Currency: USD" "Entity: ToolHound Inc."; do
  grep -qF "$want" <<<"$bare" && echo "PASS  fixed value: $want" \
    || { echo "FAIL  fixed value missing: $want"; fail=1; }
done

# The sequence is the reason 0009 exists: the acknowledgement form governs it,
# and it reads TSG-0001. Padding has to survive the count to the end of the run,
# because the vendor prints the description literally.
pad=$(python3 - <<'PY' | python3 ../scripts/build_ramp_po.py
import json
print(json.dumps([{"order_ref":"THL-PAD","company_name":"Padding Co",
  "contact_name":"Ann Lee","contact_email":"a@x.example","address":"1 St",
  "city":"Ames","state_province":"IA","postal_code":"50010","country":"US",
  "logo_choice":"toolhound_logo","full_color":"No",
  "label_width_in":1.5,"label_height_in":0.75,
  "quantity":500,"seq_start":"TSG-0001"}]))
PY
)
if grep -qF "SEQUENCE START: TSG-0001; SEQUENCE END: TSG-0500" <<<"$pad"; then
  echo "PASS  padding survives the count: TSG-0001 over 500 ends TSG-0500"
else
  echo "FAIL  padding lost counting TSG-0001 over 500 labels"
  fail=1
fi

# An order predating 0009 has no seq_start at all. Falling back to the legacy
# integer keeps those buildable rather than emitting NEEDS INPUT.
legacy=$(python3 - <<'PY' | python3 ../scripts/build_ramp_po.py
import json
print(json.dumps([{"order_ref":"THL-OLD","company_name":"Legacy Co",
  "contact_name":"Ann Lee","contact_email":"a@x.example","address":"1 St",
  "city":"Ames","state_province":"IA","postal_code":"50010","country":"US",
  "logo_choice":"toolhound_logo","full_color":"No",
  "label_width_in":1.5,"label_height_in":0.75,
  "quantity":500,"start_seq":1000}]))
PY
)
if grep -qF "SEQUENCE START: 1000; SEQUENCE END: 1499" <<<"$legacy"; then
  echo "PASS  pre-0009 order falls back to the legacy integer start"
else
  echo "FAIL  pre-0009 order did not fall back to start_seq"
  fail=1
fi

# --seq-start corrects an order, and says so, because a sequence that did not
# come from the customer is worth a second look.
override=$(python3 ../scripts/build_ramp_po.py --file row_supplied.json --seq-start ABC-0100)
for want in "SEQUENCE START: ABC-0100; SEQUENCE END: ABC-3099" \
            "came from the command line"; do
  grep -qF "$want" <<<"$override" && echo "PASS  --seq-start override: $want" \
    || { echo "FAIL  --seq-start override missing: $want"; fail=1; }
done

# A label number with no trailing digit cannot describe a range at all. Saying
# so beats printing an invented end on a vendor PO.
nodigit=$(python3 ../scripts/build_ramp_po.py --file row_supplied.json --seq-start TSG-X)
if grep -qF "does not end in a digit" <<<"$nodigit"; then
  echo "PASS  a label number with no trailing digit is flagged, not guessed"
else
  echo "FAIL  a label number with no trailing digit was not flagged"
  fail=1
fi

# Two people in one Attention field. Millstone Weber's signed form reads
# "Nick Tibbles/Justin Brooks"; splitting on the last space made that first
# "Nick Tibbles/Justin", last "Brooks", which is nobody -- and it would have
# reached Metalcraft as the delivery contact.
two=$(python3 - <<'PY2' | python3 ../scripts/build_ramp_po.py
import json
print(json.dumps([{"order_ref":"THL-TWO","company_name":"Millstone Weber",
  "contact_name":"Nick Tibbles/Justin Brooks","contact_email":"a@x.example",
  "address":"601 Fountain Lakes Blvd","city":"Saint Charles","state_province":"MO",
  "postal_code":"63301","country":"US","attention_name":"Nick Tibbles/Justin Brooks",
  "logo_choice":"custom_logo","logo_file_name":"mw.pdf","full_color":"No",
  "label_width_in":1.5,"label_height_in":0.75,"quantity":5000,"seq_start":"10000"}]))
PY2
)
if grep -qF "Ship-to first name: Nick Tibbles/Justin Brooks" <<<"$two" \
   && grep -qF "names more than one person" <<<"$two"; then
  echo "PASS  two people in one contact field are flagged, not split"
else
  echo "FAIL  two-person contact field mishandled:"
  grep -E "^Ship-to (first|last) name" <<<"$two" | sed 's/^/      /'
  fail=1
fi

# A single name must still split, or this fix would have broken every order.
if grep -qF "Ship-to first name: Mike" <<<"$supplied" \
   && grep -qF "Ship-to last name: Betts" <<<"$supplied"; then
  echo "PASS  an ordinary name still splits into first and last"
else
  echo "FAIL  an ordinary name no longer splits"
  fail=1
fi

# "1 through 500" is an ordinary unpadded run, not a padding problem. Warning
# on it cried wolf on real orders (Phoenix, Thomas Kanata).
unpadded=$(python3 - <<'PY2' | python3 ../scripts/build_ramp_po.py
import json
print(json.dumps([{"order_ref":"THL-PLAIN","company_name":"Plain Co",
  "contact_name":"Ann Lee","contact_email":"a@x.example","address":"1 St",
  "city":"Ames","state_province":"IA","postal_code":"50010","country":"US",
  "logo_choice":"toolhound_logo","full_color":"No","label_width_in":1.5,
  "label_height_in":0.75,"quantity":500,"seq_start":"1"}]))
PY2
)
if grep -qF "SEQUENCE START: 1; SEQUENCE END: 500" <<<"$unpadded" \
   && ! grep -qiF "padding" <<<"$unpadded"; then
  echo "PASS  an unpadded run is not flagged for growing a digit"
else
  echo "FAIL  unpadded run wrongly flagged:"
  grep -iF "padding" <<<"$unpadded" | sed 's/^/      /'
  fail=1
fi

# A zero-padded run that outgrows its width still is a problem: the customer
# chose a fixed width and the vendor prints the description literally.
broke=$(python3 - <<'PY2' | python3 ../scripts/build_ramp_po.py
import json
print(json.dumps([{"order_ref":"THL-BROKE","company_name":"Padded Co",
  "contact_name":"Ann Lee","contact_email":"a@x.example","address":"1 St",
  "city":"Ames","state_province":"IA","postal_code":"50010","country":"US",
  "logo_choice":"toolhound_logo","full_color":"No","label_width_in":1.5,
  "label_height_in":0.75,"quantity":20000,"seq_start":"TSG-0001"}]))
PY2
)
if grep -qF "breaks its padding" <<<"$broke"; then
  echo "PASS  a zero-padded run that outgrows its width is still flagged"
else
  echo "FAIL  padded run breaking its width was not flagged"
  fail=1
fi

# Whatever the padding, a label number longer than the form can carry is wrong.
overcap=$(python3 - <<'PY2' | python3 ../scripts/build_ramp_po.py
import json
print(json.dumps([{"order_ref":"THL-CAP","company_name":"Cap Co",
  "contact_name":"Ann Lee","contact_email":"a@x.example","address":"1 St",
  "city":"Ames","state_province":"IA","postal_code":"50010","country":"US",
  "logo_choice":"toolhound_logo","full_color":"No","label_width_in":1.5,
  "label_height_in":0.75,"quantity":2,"seq_start":"999999999"}]))
PY2
)
if grep -qF "longer than the 9" <<<"$overcap"; then
  echo "PASS  a run ending past the 9-character label limit is flagged"
else
  echo "FAIL  over-length label number not flagged"
  fail=1
fi

exit $fail
