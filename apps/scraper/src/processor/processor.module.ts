import { Module } from '@nestjs/common';
import { DatabaseModule, ScrapeQueueModule } from '@app/shared';
import { FetcherModule } from '../fetcher/fetcher.module';
import { ScrapeProcessor } from './scrape.processor';
import { JobEventsPublisher } from './job-events.publisher';

@Module({
  imports: [DatabaseModule, ScrapeQueueModule, FetcherModule],
  providers: [ScrapeProcessor, JobEventsPublisher],
})
export class ProcessorModule {}
