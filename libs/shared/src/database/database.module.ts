import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JobEntity } from './job.entity';
import { JobsService } from './jobs.service';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // DB_SYNCHRONIZE explicitly controls TypeORM auto-sync, decoupled from
        // NODE_ENV. Defaults: on in non-prod, off in prod. Production should
        // run real migrations instead.
        const syncOverride = config.get<string>('DB_SYNCHRONIZE');
        const synchronize =
          syncOverride !== undefined
            ? syncOverride === 'true'
            : config.get<string>('NODE_ENV') !== 'production';
        return {
          type: 'postgres' as const,
          host: config.get<string>('POSTGRES_HOST', 'localhost'),
          port: parseInt(config.get<string>('POSTGRES_PORT', '5432'), 10),
          username: config.get<string>('POSTGRES_USER', 'netnut'),
          password: config.get<string>('POSTGRES_PASSWORD', 'netnut'),
          database: config.get<string>('POSTGRES_DB', 'netnut'),
          entities: [JobEntity],
          synchronize,
          logging: config.get<string>('TYPEORM_LOGGING') === 'true',
        };
      },
    }),
    TypeOrmModule.forFeature([JobEntity]),
  ],
  providers: [JobsService],
  exports: [JobsService],
})
export class DatabaseModule {}
