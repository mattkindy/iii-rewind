| Arm | Runs | Interrupted | Interrupted that finished | Never finished | Booked | Booked, one invite | Booked, two invites from the agent’s retry | Booked, two invites across executions | Invites for runs that did not book | Model calls made / uninterrupted | Repeated model calls | Executions | Fenced writes | Repeats email::send dropped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rival | 40 | 22 | 0 | 22 | 11 | 10 | 1 | 0 | 5 | 69 / 42 (22 runs with none) | 0 | none | 0 | 0 |
| rival-retry | 40 | 24 | 24 | 0 | 27 | 20 | 1 | 6 | 3 | 135 / 99 | 36 | none | 0 | 0 |
| recovery | 40 | 20 | 20 | 0 | 24 | 24 | 0 | 0 | 0 | 104 / 95 | 9 | 55 | 0 | 1 |
| queue | 40 | 17 | 17 | 0 | 26 | 23 | 3 | 0 | 2 | 110 / 99 | 11 | 57 | 0 | 2 |
| journal-kill | 40 | 0 | 0 | 0 | 29 | 25 | 4 | 0 | 0 | 104 / 104 | 0 | 40 | 0 | 0 |
| zombie | 40 | 11 | 11 | 0 | 24 | 21 | 3 | 0 | 2 | 98 / 97 | 1 | 44 | 4 | 1 |

| Arm | Journal per step, ms p50 / p99 | Journal per run (begin and finish), ms p50 / p99 | Run as the caller saw it, ms p50 / p99 | Steps |
| --- | --- | --- | --- | --- |
| plain | none | none | 2679 / 4112 | 0 |
| journal | 2.66 / 5.37 | 3.22 / 4.31 | 2676 / 4873 | 210 |
| queue-calm | 2.68 / 4.46 | 2.61 / 3.66 | 2813 / 5089 | 205 |
| rival | none | none | 1341 / 4345 | 0 |
| rival-retry | none | none | 3267 / 8765 | 0 |
| recovery | 2.64 / 6.12 | 3.17 / 8.78 | 2952 / 4606 | 190 |
| queue | 2.67 / 10.72 | 3.31 / 5.93 | 2990 / 5631 | 202 |
| journal-kill | 2.68 / 706.05 | 2.83 / 707.71 | 2664 / 6338 | 212 |
| zombie | 2.73 / 6.98 | 3.49 / 5.15 | 2827 / 6818 | 198 |

- plain: today’s code, nothing killed. Faults at none; the burst took 19358 ms.
- journal: the journal, nothing killed. Faults at none; the burst took 18576 ms.
- queue-calm: the journal with runs started through the queue, nothing killed. Faults at none; the burst took 18301 ms.
- rival: today’s code, agent killed. Faults at 1671 ms, 6564 ms, 12629 ms; the burst took 18466 ms.
- rival-retry: today’s code with the caller starting a stopped run over, agent killed. Faults at 1675 ms, 6573 ms, 12625 ms; the burst took 18668 ms.
- recovery: the journal and its recovery, agent killed. Faults at 1670 ms, 6569 ms, 12626 ms; the burst took 18717 ms.
- queue: the journal with runs started through the queue, agent killed. Faults at 1674 ms, 6564 ms, 12635 ms; the burst took 20246 ms.
- journal-kill: the journal, journal killed once. Faults at 1782 ms; the burst took 17672 ms.
- zombie: the journal, the agent’s connection cut for 1.5 s while it keeps running. Faults at 3133 ms; the burst took 18675 ms.
