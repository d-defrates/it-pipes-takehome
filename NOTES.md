

exit 137- memory overcommit, OOM: this is probably occuring because 10 concurrent jobs on 4 GB RAM, each job taking 2 GB?


Why are the worker fleets shared for import and export? They have different job profiles and we don't want export requests to affect our import processes. They need to be divided into 2 different queues.

## Costs
1. S3 storage- eventually will want to implement lifecycle policies to move files into Glacier. Don't have to implement immediately.
2. Export takes so a long time, Fargate might not be the best choice for these tasks. This may be a heavier lift moving the export jobs to an EC@ architecture.


# Coding Concerns
1. timeout- 30s doesn't make sense for jobs that can take 10minutes or more
2.