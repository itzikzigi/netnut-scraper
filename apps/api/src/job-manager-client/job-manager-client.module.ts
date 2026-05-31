import { Module } from '@nestjs/common';
import { JobManagerClient } from './job-manager-client.service';

@Module({
  providers: [JobManagerClient],
  exports: [JobManagerClient],
})
export class JobManagerClientModule {}
