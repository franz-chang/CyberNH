# Extracted Rules Text

Source PDF: `rules/raw/规则.pdf`

PDF metadata: 3 pages, created 2026-06-10 20:46:03 CST.

## Page 1

### 6. Others

#### A. Task Interruption and Preemption Logic

Problem context:

In real care environments, caregivers frequently face interruptions. The simulation may need to define whether and how ongoing tasks can be interrupted by higher-priority events.

Example scenario:

A caregiver is executing a Light Task, for example handing water. During execution, a High-Priority Alert, for example fall detected, is triggered in a nearby room.

Required system behavior:

Interrupted tasks must either enter a Paused State with remaining execution time preserved, or be abandoned and regenerated.

Metrics to record:

- Number of interrupted tasks
- Delay added to interrupted tasks due to preemption

## Page 2

### 6. Others

#### B. Contextualizing Eldercare Operations

##### B1. Resident Acuity-Task Probability Coupling

Care levels will influence task type probability. The probability of light tasks for all the residents are the same. But:

- Care Level 1 (Low):
  - Medium Task probability approximately 20-30%
  - Heavy Task probability approximately 5-10%
- Care Level 2 (Medium):
  - Medium Task probability approximately 40-60%
  - Heavy Task probability approximately 10-30%
- Care Level 3 (High):
  - Medium Task probability approximately 20-30%
  - Heavy Task probability approximately 50-70%

##### B2. Two-Person Assistance Coordination Logic

Certain heavy tasks, for example transfers, require two caregivers to be present simultaneously. In this case, the first arriving agent enters a Coordination Waiting State until the second agent arrives. Task execution begins only when both agents are present.

##### B3. Invisible Workload

Direct care tasks alone underestimate caregiver workload. The invisible work may force caregiver return to central locations/activity rooms/gardens to acquire required materials, affecting walking patterns, congestion, and response times.

## Page 3

### 7. Quantifiable Output Metrics

Metric categories: Resident-side / Caregiver-side / System-side.

Specific metrics and definitions:

- Average waiting time (min): Mean time from call to caregiver arrival.
- Coordination waiting time: Time the first agent waits for the second agent to arrive.
- P95 waiting time (min): 95th percentile of waiting times.
- Timeout / overtime rate (%): Proportion of calls with waiting time greater than secondary-call threshold.
- Total walking distance (m/shift): Cumulative walking distance per caregiver per shift.
- Total task processing time (min/shift): Sum of time spent actively executing tasks per shift, excluding idle.
- Heavy-task count distribution: Distribution of heavy tasks handled per caregiver, report standard deviation or Gini coefficient.
- Task completion rate (%): Completed tasks divided by generated tasks.
- Caregiver utilization (%): Task time plus movement time divided by total on-duty time.
