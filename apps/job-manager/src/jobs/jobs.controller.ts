import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { JobsService } from '@app/shared';
import { JobsQueueService } from './jobs-queue.service';
import { CreateJobDto } from './dto/create-job.dto';

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly queue: JobsQueueService,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateJobDto) {
    const job = await this.jobs.create(dto.url);
    await this.queue.enqueue({ jobId: job.id, url: job.url });
    return job;
  }

  @Get(':id')
  findById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.jobs.findById(id);
  }
}
