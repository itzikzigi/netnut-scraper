import { Module } from '@nestjs/common';
import { DatabaseModule, ScrapeQueueModule } from '@app/shared';
import { JobsQueueService } from './jobs-queue.service';
import { JobsController } from './jobs.controller';

@Module({
  imports: [DatabaseModule, ScrapeQueueModule],
  controllers: [JobsController],
  providers: [JobsQueueService],
  exports: [JobsQueueService],
})
export class JobsModule {}
