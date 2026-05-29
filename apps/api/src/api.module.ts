import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScrapeModule } from './scrape/scrape.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ScrapeModule],
  controllers: [],
  providers: [],
})
export class ApiModule {}
