# Job state machine: enforce legal transitions (#1)

This change enforces that jobs can only transition from one valid state to another.
The allowed transitions are:
- proposed -> confirmed or declined
- confirmed -> submitted or declined
- submitted -> completed or declined
- completed -> terminal (no further transitions)
- declined -> terminal (no further transitions)

This change ensures that the job state machine is properly enforced, preventing
invalid state transitions that could lead to inconsistent job states or incorrect
workflow behavior.