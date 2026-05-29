import { Module } from '@nestjs/common';
import { FetcherService } from './fetcher.service';
import { ProxyPoolService } from './proxy-pool.service';

@Module({
  providers: [FetcherService, ProxyPoolService],
  exports: [FetcherService, ProxyPoolService],
})
export class FetcherModule {}
