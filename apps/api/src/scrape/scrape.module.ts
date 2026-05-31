import { Module } from '@nestjs/common';
import { ResultStoreModule } from '@app/shared';
import { JobManagerClientModule } from '../job-manager-client/job-manager-client.module';
import { EventsModule } from '../events/events.module';
import { ScrapeController } from './scrape.controller';
import { ScrapeService } from './scrape.service';

@Module({
  imports: [JobManagerClientModule, EventsModule, ResultStoreModule],
  controllers: [ScrapeController],
  providers: [ScrapeService],
})
export class ScrapeModule {}
