import { Module } from '@nestjs/common';
import { FetcherService } from './fetcher.service';

@Module({
  providers: [FetcherService],
  exports: [FetcherService],
})
export class FetcherModule {}
