import {
  HttpException,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { JobResponseDto } from '@app/shared';

@Injectable()
export class JobManagerClient implements OnModuleInit {
  private client!: AxiosInstance;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.client = axios.create({
      baseURL: this.config.get<string>('JOB_MANAGER_URL', 'http://localhost:3001'),
      timeout: 5000,
    });
  }

  async createJob(url: string): Promise<JobResponseDto> {
    return this.call(() => this.client.post<JobResponseDto>('/jobs', { url }));
  }

  async getJob(id: string): Promise<JobResponseDto> {
    return this.call(() => this.client.get<JobResponseDto>(`/jobs/${id}`));
  }

  private async call<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    try {
      const { data } = await fn();
      return data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        throw new HttpException(err.response.data ?? err.message, err.response.status);
      }
      throw new ServiceUnavailableException('Job Manager unavailable');
    }
  }
}
