# Rules Data Coverage Report

Source: `rules/raw/规则.pdf`

Generated assets:

- `rules/extracted/rules_text.txt`: raw `pdftotext` extraction.
- `rules/extracted/rules_text.md`: cleaned human-readable extraction with page markers.
- `rules/structured/rule_schema.json`: schema family for rule, metric, and fine-tune seed objects.
- `rules/structured/rules.jsonl`: structured behavioral and simulation rules.
- `rules/structured/metrics.jsonl`: structured metric definitions.
- `rules/datasets/train_seed.jsonl`: seed examples for future fine-tuning or supervised instruction data.
- `rules/datasets/eval_cases.jsonl`: deterministic cases for rule compliance checks.

## Coverage Summary

| PDF section | Covered by | Count |
| --- | --- | ---: |
| 6.A Task Interruption and Preemption Logic | `rules.jsonl`, `metrics.jsonl`, `train_seed.jsonl`, `eval_cases.jsonl` | 4 rules/metrics |
| 6.B1 Resident Acuity-Task Probability Coupling | `rules.jsonl`, `train_seed.jsonl`, `eval_cases.jsonl` | 4 rules |
| 6.B2 Two-Person Assistance Coordination Logic | `rules.jsonl`, `metrics.jsonl`, `train_seed.jsonl`, `eval_cases.jsonl` | 3 rules/metrics |
| 6.B3 Invisible Workload | `rules.jsonl`, `train_seed.jsonl`, `eval_cases.jsonl` | 2 rules |
| 7 Quantifiable Output Metrics | `metrics.jsonl`, `train_seed.jsonl`, `eval_cases.jsonl` | 9 metrics |

## Notes

- The PDF contains high-level rules rather than complete executable thresholds for preemption priority comparison. `rules.jsonl` therefore records preemption as a hard requirement to evaluate, while leaving the exact priority-gap threshold as an implementation decision.
- Care-level task probabilities are approximate ranges. They are encoded as soft rules unless a scenario explicitly decides to enforce exact sampling bounds.
- The two-person assistance rules are encoded as hard rules because the PDF states that execution begins only when both caregivers are present.
- The invisible workload rules are encoded as soft modeling requirements because the PDF specifies operational effects but not exact timing or route-cost formulas.
- The metric definitions are directly datafied with formulas and required event fields so they can be connected to simulation logs later.
