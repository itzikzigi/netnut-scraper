import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ResultStoreService } from './result-store.service';

@Module({
  imports: [ConfigModule],
  providers: [ResultStoreService],
  exports: [ResultStoreService],
})
export class ResultStoreModule {}
