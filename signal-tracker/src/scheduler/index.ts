import { createLogger } from '../utils/logger.js';

const logger = createLogger('scheduler');

type Job = {
  name: string;
  interval: number;
  lastRun: number;
  handler: () => Promise<void>;
};

export class Scheduler {
  private jobs: Job[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL = 10000; // Check every 10 seconds

  start(): void {
    logger.info('Scheduler started');
    this.timer = setInterval(() => this.checkJobs(), this.CHECK_INTERVAL);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Scheduler stopped');
  }

  schedule(name: string, intervalMs: number, handler: () => Promise<void>): void {
    this.jobs.push({
      name,
      interval: intervalMs,
      lastRun: Date.now(),
      handler,
    });
    logger.info({ name, intervalMs }, 'Job scheduled');
  }

  private async checkJobs(): Promise<void> {
    const now = Date.now();

    for (const job of this.jobs) {
      if (now - job.lastRun >= job.interval) {
        job.lastRun = now;
        try {
          await job.handler();
        } catch (error) {
          logger.error({ error, job: job.name }, 'Job failed');
        }
      }
    }
  }

  getJobs(): Array<{ name: string; interval: number; lastRun: number; }> {
    return this.jobs.map(j => ({
      name: j.name,
      interval: j.interval,
      lastRun: j.lastRun,
    }));
  }
}