import { Module } from '@nestjs/common';
import { ClubgasClient } from './clubgas.client';

@Module({
  providers: [ClubgasClient],
  exports: [ClubgasClient],
})
export class ClubgasModule {}
