import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ProcessorModule } from './processor/processor.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ProcessorModule],
  controllers: [],
  providers: [],
})
export class ScraperModule {}
