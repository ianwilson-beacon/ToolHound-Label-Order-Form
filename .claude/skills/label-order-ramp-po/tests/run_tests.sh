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

# A run with nothing supplied must not invent values, and must say what it needs.
bare=$(python3 ../scripts/build_ramp_po.py --file shaw_rows.json)
for want in "Line 1 rate: NEEDS INPUT" "Metalcraft Quotation: NEEDS INPUT" \
            "PO total (check): NEEDS INPUT" "label size is not captured"; do
  if grep -qF "$want" <<<"$bare"; then
    echo "PASS  missing input surfaced: $want"
  else
    echo "FAIL  missing input NOT surfaced: $want"
    fail=1
  fi
done

# Vendor and currency are fixed for label orders.
for want in "Vendor: Metalcraft USD" "Currency: USD" "Entity: ToolHound Inc."; do
  grep -qF "$want" <<<"$bare" && echo "PASS  fixed value: $want" \
    || { echo "FAIL  fixed value missing: $want"; fail=1; }
done

exit $fail
