#!/bin/bash
# SWE-bench Verified Benchmark Runner for TraceBase
#
# Usage:
#   ./eval/swebench/run-benchmark.sh --model haiku --count 20
#   ./eval/swebench/run-benchmark.sh --model sonnet --count 20
#
# This runs baseline + augmented on SWE-bench Verified and evaluates patches.

set -e

MODEL_SHORT="${1:-haiku}"
COUNT="${2:-5}"
SUBSET="verified"
SPLIT="test"
RESULTS_DIR="eval/swebench/results"

# Map model short names to litellm model IDs
case "$MODEL_SHORT" in
  haiku)   MODEL="anthropic/claude-haiku-4-5-20251001" ;;
  sonnet)  MODEL="anthropic/claude-sonnet-4-6" ;;
  opus)    MODEL="anthropic/claude-opus-4-6" ;;
  *)       MODEL="$MODEL_SHORT" ;;
esac

echo "=============================="
echo "SWE-bench Verified Benchmark"
echo "Model: $MODEL"
echo "Tasks: $COUNT"
echo "=============================="

# Phase 1: Baseline (standard mini-swe-agent, no injection)
echo ""
echo "--- Phase 1: Baseline ---"
BASELINE_DIR="$RESULTS_DIR/baseline-$MODEL_SHORT"
rm -rf "$BASELINE_DIR"

python3 -m minisweagent.run.benchmarks.swebench \
  --subset "$SUBSET" \
  --split "$SPLIT" \
  --slice "0:$COUNT" \
  --model "$MODEL" \
  --output "$BASELINE_DIR" \
  --workers 1 \
  -c swebench.yaml \
  -c "agent.cost_limit=0.50" \
  -c "agent.step_limit=25" \
  -c "model.model_name=$MODEL"

echo ""
echo "--- Phase 2: Augmented (with TraceBase injection) ---"
AUGMENTED_DIR="$RESULTS_DIR/augmented-$MODEL_SHORT"
rm -rf "$AUGMENTED_DIR"

python3 -m minisweagent.run.benchmarks.swebench \
  --subset "$SUBSET" \
  --split "$SPLIT" \
  --slice "0:$COUNT" \
  --model "$MODEL" \
  --output "$AUGMENTED_DIR" \
  --workers 1 \
  -c eval/swebench/config-augmented.yaml \
  -c "model.model_name=$MODEL"

echo ""
echo "--- Phase 3: Evaluate patches ---"
echo "Baseline results:"
ls "$BASELINE_DIR"/*/*.traj.json 2>/dev/null | wc -l | xargs echo "  Trajectories:"
echo "Augmented results:"
ls "$AUGMENTED_DIR"/*/*.traj.json 2>/dev/null | wc -l | xargs echo "  Trajectories:"

echo ""
echo "Done. Evaluate patches with:"
echo "  python3 -m swebench.harness.run_evaluation --predictions_path $BASELINE_DIR --run_id baseline-$MODEL_SHORT"
echo "  python3 -m swebench.harness.run_evaluation --predictions_path $AUGMENTED_DIR --run_id augmented-$MODEL_SHORT"
