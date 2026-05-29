import { Module } from '@nestjs/common';
import { DatabaseModule, ScrapeQueueModule } from '@app/shared';
import { JobsQueueService } from './jobs-queue.service';

@Module({
  imports: [DatabaseModule, ScrapeQueueModule],
  providers: [JobsQueueService],
  exports: [JobsQueueService],
})
export class JobsModule {}
