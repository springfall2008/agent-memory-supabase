#!/bin/sh
# Toy measurement for runner/examples/toy.toml: passes when BOARD_CANDIDATE is the smallest n whose square ends in 444.
answer=$(python3 -c 'print(next(n for n in range(1, 10**6) if str(n * n).endswith("444")))')
echo "candidate: ${BOARD_CANDIDATE:-<none>}"
echo "expected: $answer"
if [ "${BOARD_CANDIDATE:-}" = "$answer" ]; then
  echo "pass"
  exit 0
fi
echo "fail"
exit 1
