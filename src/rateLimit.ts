import { CONSTANTS } from './legacy/config';

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class RateLimitHandler {
  private static retryCount = 0;
  private static lastRetryTime = 0;

  static async handleRateLimit(operation: () => Promise<any>): Promise<any> {
    try {
      // Reset retry count if it's been a while since last retry
      if (Date.now() - this.lastRetryTime > CONSTANTS.MAX_RETRY_DELAY) {
        this.retryCount = 0;
      }

      return await operation();
    } catch (error: any) {
      if (error?.message?.includes('429') || error?.response?.status === 429) {
        this.retryCount++;
        this.lastRetryTime = Date.now();

        // Calculate delay with exponential backoff
        const delay = Math.min(
          CONSTANTS.MIN_RETRY_DELAY * Math.pow(2, this.retryCount - 1),
          CONSTANTS.MAX_RETRY_DELAY
        );

        console.log(`Rate limit hit. Retrying after ${delay/1000}s delay...`);
        await sleep(delay);
        return this.handleRateLimit(operation);
      }
      throw error;
    }
  }

  static reset() {
    this.retryCount = 0;
    this.lastRetryTime = 0;
  }
}