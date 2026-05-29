export const SCRAPE_QUEUE_NAME = 'scrape-jobs';

export const JOB_COMPLETED_CHANNEL = (jobId: string) => `job:${jobId}:done`;
