import { Module } from '@nestjs/common';
import { JobEventsService } from './job-events.service';

@Module({
  providers: [JobEventsService],
  exports: [JobEventsService],
})
export class EventsModule {}
