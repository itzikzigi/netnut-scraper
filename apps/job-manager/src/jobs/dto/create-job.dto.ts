import { IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateJobDto {
  @IsString()
  @IsUrl({ require_protocol: true, require_valid_protocol: true })
  @MaxLength(2048)
  url!: string;
}
