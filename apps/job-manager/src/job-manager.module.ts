import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '@app/shared';
import { JobsModule } from './jobs/jobs.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, JobsModule],
  controllers: [],
  providers: [],
})
export class JobManagerModule {}
