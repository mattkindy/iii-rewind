#!/bin/sh
# Runs every arm of the durable burst once, one after another, and keeps each arm's timeline in
# results/<arm>.txt beside its results/<arm>.json. Run from this folder: sh allArms.sh [count] [seed]
count=${1:-40}
seed=${2:-7}
uptime > results/machine.txt
for arm in plain journal queue-calm rival rival-retry recovery queue journal-kill zombie; do
  npx tsx burst.ts "$arm" "$count" "$seed" 2>&1 | grep -v '^\[OTel\]\|^\[iii\]' > "results/$arm.txt"
  uptime >> results/machine.txt
done
