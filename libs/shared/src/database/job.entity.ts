import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ScrapeJob, JobStatus } from '../types';

@Entity('jobs')
export class JobEntity implements ScrapeJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('text')
  url!: string;

  @Index()
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: JobStatus;

  @Column('text', { nullable: true })
  html!: string | null;

  @Column('text', { nullable: true })
  error!: string | null;

  @Column('int', { default: 0 })
  attempts!: number;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'proxy_used' })
  proxyUsed!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
