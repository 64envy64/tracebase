#!/usr/bin/env python3
"""ETL pipeline — off-variant final state (still broken).

The agent ran without TraceBase and never applied the case-fix. The
script still references row['amount'], which raises KeyError at
runtime because the CSV header is upper-case.
"""
import csv

with open("input.csv") as f:
    reader = csv.DictReader(f)
    total = 0
    for row in reader:
        total += int(row["amount"])

with open("output.txt", "w") as f:
    f.write(f"OK total={total}\n")
