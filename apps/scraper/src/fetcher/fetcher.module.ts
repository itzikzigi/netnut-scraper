import { Module } from '@nestjs/common';
import { FetcherService } from './fetcher.service';
import { ProxyPoolService } from './proxy-pool.service';
import { UrlSafetyService } from './url-safety.service';

@Module({
  providers: [FetcherService, ProxyPoolService, UrlSafetyService],
  exports: [FetcherService, ProxyPoolService],
})
export class FetcherModule {}
