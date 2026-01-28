# Exemplo de Aplicação do PrimeiroLoginGuard

## Como Aplicar o Guard em Controllers

O `PrimeiroLoginGuard` deve ser aplicado em controllers que você deseja proteger, impedindo que usuários que ainda não trocaram a senha acessem essas rotas.

### Exemplo 1: Controller de Veículos

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrimeiroLoginGuard } from '../auth/primeiro-login.guard';

@Controller('veiculos')
@UseGuards(JwtAuthGuard, PrimeiroLoginGuard) // Aplicar ambos os guards
export class VeiculosController {
  @Get()
  findAll() {
    // Usuários com primeiroLogin: true não podem acessar
    return 'Lista de veículos';
  }
}
```

### Exemplo 2: Controller de Economia

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrimeiroLoginGuard } from '../auth/primeiro-login.guard';

@Controller('economia')
@UseGuards(JwtAuthGuard, PrimeiroLoginGuard)
export class EconomiaController {
  @Get()
  getEconomia() {
    // Rota protegida
    return 'Dados de economia';
  }
}
```

### Exemplo 3: Aplicação em Rotas Específicas

Se você quiser aplicar o guard apenas em rotas específicas, em vez do controller inteiro:

```typescript
import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrimeiroLoginGuard } from '../auth/primeiro-login.guard';

@Controller('documentos')
export class DocumentosController {
  // Esta rota permite acesso mesmo com primeiroLogin: true
  @UseGuards(JwtAuthGuard)
  @Get('public')
  getPublicDocs() {
    return 'Documentos públicos';
  }

  // Esta rota bloqueia usuários com primeiroLogin: true
  @UseGuards(JwtAuthGuard, PrimeiroLoginGuard)
  @Get('private')
  getPrivateDocs() {
    return 'Documentos privados';
  }
}
```

## Rotas que NÃO devem ter o PrimeiroLoginGuard

### ❌ NÃO APLICAR EM:

1. **Rotas de autenticação**:
   - `POST /auth/login`
   - `POST /auth/register`
   - `GET /auth/me`

2. **Primeiro acesso**:
   - `POST /associado/primeiro-acesso`

3. **⚠️ CRÍTICO - Troca de senha**:
   - `PATCH /associado/password` - **DEVE FICAR ACESSÍVEL**

### ✅ APLICAR EM:

- Controllers de recursos protegidos (veículos, economia, documentos, etc.)
- Qualquer rota que exija que o usuário tenha trocado a senha

## Módulos que Precisam Importar o AuthModule

Se um controller em outro módulo quiser usar o `PrimeiroLoginGuard`, o módulo precisa importar o `AuthModule`:

```typescript
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VeiculosController } from './veiculos.controller';
import { VeiculosService } from './veiculos.service';

@Module({
  imports: [AuthModule], // Importar para ter acesso ao guard
  controllers: [VeiculosController],
  providers: [VeiculosService],
})
export class VeiculosModule {}
```

## Comportamento do Guard

### Quando `primeiroLogin: true`

**Request**:
```bash
GET /api/economia
Authorization: Bearer <token>
```

**Response** (403 Forbidden):
```json
{
  "statusCode": 403,
  "message": "É necessário trocar a senha antes de acessar outras funcionalidades",
  "primeiroLogin": true
}
```

### Quando `primeiroLogin: false`

**Request**:
```bash
GET /api/economia
Authorization: Bearer <token>
```

**Response** (200 OK):
```json
{
  "economia": { ... }
}
```

## Ordem dos Guards

A ordem importa! Sempre coloque `JwtAuthGuard` primeiro:

```typescript
// ✅ CORRETO
@UseGuards(JwtAuthGuard, PrimeiroLoginGuard)

// ❌ ERRADO
@UseGuards(PrimeiroLoginGuard, JwtAuthGuard)
```

O `JwtAuthGuard` precisa rodar primeiro para validar o token e adicionar o objeto `user` no request, que será usado pelo `PrimeiroLoginGuard`.

## Controllers Sugeridos para Aplicação

Considere aplicar o guard nos seguintes controllers:

- ✅ `src/economia/economia.controller.ts`
- ✅ `src/documentos/documentos.controller.ts`
- ✅ `src/oficina/oficina.controller.ts`
- ✅ `src/postos/postos.controller.ts`
- ✅ `src/rastreamento/rastreamento.controller.ts`
- ✅ `src/cartao/cartao.controller.ts`
- ❌ `src/associado/associado.controller.ts` - Não aplicar no endpoint `password`
- ❌ `src/auth/auth.controller.ts` - Não aplicar

## Exemplo Completo: AssociadoController

```typescript
import { UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrimeiroLoginGuard } from '../auth/primeiro-login.guard';
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  ParseIntPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AssociadoService } from './associado.service';
import { UpdateAssociadoDto } from './DTOs/update-associado.dto';
import { PrimeiroAcessoDto } from './DTOs/primeiro-acesso.dto';

@Controller('associado')
export class AssociadoController {
  constructor(private readonly associadoService: AssociadoService) {}

  // Não protegido - qualquer um pode acessar
  @Post('primeiro-acesso')
  async primeiroAcesso(@Body() data: PrimeiroAcessoDto) {
    return this.associadoService.primeiroAcesso(data.cpf);
  }

  // Protegido com ambos os guards
  @UseGuards(JwtAuthGuard, PrimeiroLoginGuard)
  @Get(':id')
  async findById(@Param('id', ParseIntPipe) id: number) {
    return this.associadoService.findById(id);
  }

  // Protegido com ambos os guards
  @UseGuards(JwtAuthGuard, PrimeiroLoginGuard)
  @Patch(':id')
  @UseInterceptors(FileInterceptor('profilePhoto'))
  updateAssociado(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: UpdateAssociadoDto,
    @UploadedFile() profilePhoto?: Express.Multer.File,
  ) {
    return this.associadoService.updateAssociado(id, data, profilePhoto);
  }

  /**
   * ⚠️ IMPORTANTE: Apenas JwtAuthGuard, SEM PrimeiroLoginGuard
   * Esta rota precisa estar acessível para usuários com primeiroLogin: true
   */
  @UseGuards(JwtAuthGuard)
  @Patch('password')
  async changePassword(@Request() req, @Body() body: { newPassword: string }) {
    const userId = req.user.userId;
    return this.associadoService.changePassword(userId, body.newPassword);
  }
}
```

## Resumo

1. ✅ Import `JwtAuthGuard` e `PrimeiroLoginGuard`
2. ✅ Aplicar `@UseGuards(JwtAuthGuard, PrimeiroLoginGuard)` no controller ou rota
3. ✅ Importar `AuthModule` no módulo que usa o guard
4. ❌ NÃO aplicar no endpoint de troca de senha
5. ✅ Ordem: `JwtAuthGuard` sempre primeiro

## Benefícios

- 🔒 Maior segurança: usuários são forçados a trocar senha
- 🎯 Granular: você escolhe quais rotas proteger
- 🚀 Fácil de aplicar: apenas adicionar o decorator
- 📊 Status em tempo real: consulta o banco de dados
