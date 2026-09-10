import { Global, Module } from '@nestjs/common';
import { PrismaService } from 'src/database/prisma.service';

/**
 * DatabaseModule — módulo global que provê PrismaService para toda a aplicação.
 *
 * Por ser @Global(), todos os módulos têm acesso a PrismaService via DI
 * sem precisar declará-lo em seus próprios providers.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
