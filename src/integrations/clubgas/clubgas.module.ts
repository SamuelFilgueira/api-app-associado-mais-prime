import { Module } from '@nestjs/common';
import { ClubgasClient } from './clubgas.client';
import { ClubgasErroLogService } from './clubgas-erro-log.service';

@Module({
  providers: [ClubgasClient, ClubgasErroLogService],
  exports: [ClubgasClient, ClubgasErroLogService],
})
export class ClubgasModule {}
