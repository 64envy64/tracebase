#!/usr/bin/env python3
"""ETL pipeline — on-variant final state (fixed).

With TraceBase ON, the agent recalled the prior 'CSV DictReader case-
sensitive header' pattern and applied the same fix here: row['AMOUNT']
matches the actual header.
"""
import csv

with open("input.csv") as f:
    reader = csv.DictReader(f)
    total = 0
    for row in reader:
        total += int(row["AMOUNT"])

with open("output.txt", "w") as f:
    f.write(f"OK total={total}\n")
