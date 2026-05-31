import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobEntity } from './job.entity';

@Injectable()
export class JobsService {
  constructor(
    @InjectRepository(JobEntity)
    private readonly repo: Repository<JobEntity>,
  ) {}

  create(url: string): Promise<JobEntity> {
    const job = this.repo.create({
      url,
      status: 'pending',
      attempts: 0,
      error: null,
      proxyUsed: null,
    });
    return this.repo.save(job);
  }

  async findById(id: string): Promise<JobEntity> {
    const job = await this.repo.findOne({ where: { id } });
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  async markInProgress(id: string, proxyUsed: string | null): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(JobEntity)
      .set({
        status: 'in_progress',
        proxyUsed,
        attempts: () => '"attempts" + 1',
      })
      .where('id = :id', { id })
      .execute();
  }

  async markCompleted(id: string): Promise<void> {
    // HTML is written to the Redis result cache by the caller; here we only
    // flip the durable metadata.
    await this.repo.update(id, { status: 'completed', error: null });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.repo.update(id, { status: 'failed', error });
  }
}
