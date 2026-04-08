import { Module } from '@nestjs/common';
import { AuthModule } from 'src/auth/auth.module';
import { FileUploadService } from 'src/common/services/file-upload.service';
import { PrismaService } from 'src/prisma.service';
import { SharedModule } from 'src/shared/shared.module';
import { AssociadoController } from './associado.controller';
import { AssociadoService } from './associado.service';

@Module({
  imports: [AuthModule, SharedModule],
  controllers: [AssociadoController],
  providers: [AssociadoService, PrismaService, FileUploadService],
})
export class AssociadoModule {}
