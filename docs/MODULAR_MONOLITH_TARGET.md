# Arquitetura Alvo — Modular Monolith (beneficios-api)

> Plano técnico e executável para transformar o monólito atual em um  
> Modular Monolith bem estruturado, desacoplado e sustentável.  
> Gerado a partir da análise arquitetural completa do código-fonte.

---

## Sumário

1. [O que fazer agora](#1-o-que-fazer-agora)
2. [Nova organização do monólito](#2-nova-organização-do-monólito)
3. [Regras arquiteturais](#3-regras-arquiteturais)
4. [Como melhorar o AppModule](#4-como-melhorar-o-appmodule)
5. [Como melhorar a autenticação](#5-como-melhorar-a-autenticação)
6. [Como melhorar o Prisma](#6-como-melhorar-o-prisma)
7. [Como melhorar integrações externas](#7-como-melhorar-integrações-externas)
8. [Como melhorar filas e jobs](#8-como-melhorar-filas-e-jobs)
9. [Como melhorar uploads](#9-como-melhorar-uploads)
10. [Como melhorar observabilidade](#10-como-melhorar-observabilidade)
11. [Roadmap pragmático](#11-roadmap-pragmático)

---

## 1. O que fazer agora

### 1.1 Problemas Críticos (resolver primeiro)

| # | Problema | Impacto | Ação |
|---|---|---|---|
| P1 | `PrismaService` reinstanciado em cada módulo | Pool de conexões fragmentado; risco de connection leak | Criar `DatabaseModule` global |
| P2 | `AdminPanelRoleGuard` espalhado por 5 módulos como provider direto | Acoplamento circular latente; impossibilita extração futura | Mover para `InfraModule` global |
| P3 | `SgaService` declarado como provider dentro de `ReinspectionModule` | Viola encapsulamento; impede extração | Criar `SgaModule` com exports |
| P4 | Auth admin e mobile com mesmo `JWT_SECRET` | Risco de segurança — token de usuário comum pode ser aceito em rotas admin | Separar secrets ou separar estratégia JWT |
| P5 | `MailService` declarado como provider em `AppModule` **e** `ReinspectionModule` | Duas instâncias do transporter SMTP; desperdício de conexão | Centralizar em `InfraModule` |
| P6 | `EconomiaService` importado diretamente no `FuelSessionModule` | Acoplamento sem contrato | Criar `EconomiaModule` com exports |

### 1.2 Quick Wins (baixo risco, alto impacto)

| # | Ação | Esforço | Impacto |
|---|---|---|---|
| Q1 | Expandir `env.validator.ts` para cobrir todas as ~30+ variáveis | 2h | Previne crash silencioso em produção |
| Q2 | Adicionar `@Global()` no `PrismaService` via `DatabaseModule` | 2h | Elimina 12+ redeclarações duplicadas |
| Q3 | Criar `PostosModule`, `CartaoModule`, `EconomiaModule` encapsulando os controllers/services soltos no `AppModule` | 4h | Limpa o `AppModule`; cria fronteiras reais |
| Q4 | Adicionar `app.setGlobalPrefix('api/v1')` no `main.ts` | 1h | Habilita versionamento sem breaking change imediato |
| Q5 | Adicionar `LoggingInterceptor` global com `requestId` | 3h | Correlaciona logs de toda request instantaneamente |
| Q6 | Criar `health` endpoint com `GET /api/v1/health` | 1h | Permite monitoramento e healthcheck Docker |

### 1.3 Melhorias de Alto Impacto Arquitetural

- Criar `InfraModule` global centralizando guards, interceptors, pipes e `MailService`
- Criar `SgaModule` com `SgaService` exportado corretamente
- Mover `AdminPanelRoleGuard` para infraestrutura — quebra a dependência transitiva que metade do sistema tem com `AdminPanelModule`
- Adicionar `StorageService` como abstração de upload (filesystem agora, S3 depois com zero mudança de consumidor)

---

## 2. Nova organização do monólito

### 2.1 Árvore de pastas recomendada

```
src/
│
├── main.ts                          # bootstrap limpo — apenas configuração HTTP
├── app.module.ts                    # importa apenas grupos de módulos; sem providers inline
│
├── ─── INFRAESTRUTURA ───────────────────────────────────────────────────────
│
├── database/
│   ├── database.module.ts           # @Global() — exporta PrismaService
│   └── prisma.service.ts            # único lugar onde PrismaClient é instanciado
│
├── infra/
│   ├── infra.module.ts              # @Global() — exporta guards, interceptors, MailService
│   ├── guards/
│   │   ├── jwt-auth.guard.ts        # guard de usuário mobile (reexportado de AuthModule)
│   │   ├── admin-role.guard.ts      # guard de role ADMIN (genérico, sem query extra)
│   │   └── admin-panel-role.guard.ts  # guard com query a AdminPanelUser (leve)
│   ├── interceptors/
│   │   ├── logging.interceptor.ts   # requestId, método, path, status, duração
│   │   └── transform.interceptor.ts # normalização de resposta (opcional)
│   ├── pipes/
│   │   └── validation.pipe.ts       # ValidationPipe global (configurado no main.ts)
│   ├── filters/
│   │   └── http-exception.filter.ts # formato padrão de erro
│   └── services/
│       └── mail.service.ts          # único provider global de email
│
├── config/
│   ├── env.validator.ts             # valida TODAS as variáveis antes do bootstrap
│   └── configuration.ts            # ConfigService helper (tipado)
│
├── queue/
│   └── queue.module.ts              # @Global() BullMQ — registra todas as filas
│
├── storage/
│   ├── storage.module.ts            # @Global() — exporta StorageService
│   ├── storage.service.ts           # interface: upload/delete/getUrl
│   └── providers/
│       ├── local-storage.provider.ts   # implementação filesystem
│       └── s3-storage.provider.ts      # implementação S3 (stub preparado)
│
├── shared/
│   ├── shared.module.ts             # @Global() — multi-tenancy
│   ├── base-context.service.ts      # resolve baseOrigin da request
│   ├── token-resolver.service.ts    # mapeia BaseOrigin → env vars
│   ├── sga-auth.service.ts          # cache de token SGA por BaseOrigin
│   ├── external-api-config.service.ts
│   └── log.util.ts
│
├── ─── DOMÍNIOS ─────────────────────────────────────────────────────────────
│
├── auth/                            # Domínio: Autenticação (usuário mobile)
│   ├── auth.module.ts
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   ├── jwt.strategy.ts
│   ├── local.strategy.ts
│   ├── primeiro-login.guard.ts
│   └── dto/
│
├── admin-panel/                     # Domínio: Painel Administrativo
│   ├── admin-panel.module.ts        # exporta AdminPanelUsersService
│   ├── auth/
│   │   ├── admin-auth.controller.ts
│   │   └── admin-auth.service.ts
│   ├── users/
│   │   ├── admin-users.controller.ts
│   │   └── admin-users.service.ts
│   ├── role.enum.ts
│   └── dto/
│
├── associado/                       # Domínio: Associado
│   ├── associado.module.ts
│   ├── associado.controller.ts
│   ├── associado.service.ts
│   └── dto/
│
├── reinspection/                    # Domínio: Revistoria
│   ├── reinspection.module.ts
│   ├── reinspection.controller.ts
│   ├── reinspection.service.ts
│   ├── payments/
│   │   ├── reinspection-payments.controller.ts
│   │   └── reinspection-payments.service.ts
│   └── dto/
│
├── rastreamento/                    # Domínio: Rastreamento
│   ├── rastreamento.module.ts
│   ├── rastreamento.controller.ts
│   ├── rastreamento.service.ts
│   ├── webhook.processor.ts
│   ├── softruck/
│   └── m7/
│
├── notifications/                   # Domínio: Notificações
│   ├── notifications.module.ts
│   ├── notifications.controller.ts
│   ├── notifications.service.ts
│   ├── notification.processor.ts
│   └── dto/
│
├── sga/                             # Domínio: Integração SGA / Hinova
│   ├── sga.module.ts               # exporta SgaService — consumido por outros módulos
│   ├── sga.service.ts
│   ├── boleto/
│   │   ├── boleto.controller.ts
│   │   ├── boleto.service.ts
│   │   └── boleto-verificacao.processor.ts
│   └── dto/
│
├── beneficios/                      # Domínio: Alloyal / Benefícios
│   ├── beneficios.module.ts
│   ├── alloyal/
│   │   ├── alloyal.controller.ts
│   │   └── alloyal.service.ts
│   └── dto/
│
├── postos/                          # Domínio: Postos de Combustível
│   ├── postos.module.ts
│   ├── postos.controller.ts
│   ├── postos.service.ts
│   └── dto/
│
├── cartao/                          # Domínio: Cartão ClubGas
│   ├── cartao.module.ts
│   ├── cartao.controller.ts
│   ├── cartao.service.ts
│   └── dto/
│
├── economia/                        # Domínio: Economia / Combustível
│   ├── economia.module.ts           # exporta EconomiaService
│   ├── economia.controller.ts
│   ├── economia.service.ts
│   └── dto/
│
├── fuel-session/                    # Domínio: Sessão de Abastecimento
│   ├── fuel-session.module.ts       # importa EconomiaModule
│   ├── fuel-session.service.ts
│   └── fuel-economy.processor.ts
│
├── oficina/                         # Domínio: Oficinas Parceiras
│   ├── oficina.module.ts
│   ├── oficina.controller.ts
│   ├── oficina.service.ts
│   └── dto/
│
├── documentos/                      # Domínio: Documentos
│   ├── documentos.module.ts
│   ├── documentos.controller.ts
│   ├── documentos.service.ts
│   └── dto/
│
├── slider/                          # Domínio: Slider / Banners
│   ├── slider.module.ts
│   ├── slider.controller.ts
│   ├── slider.service.ts
│   └── dto/
│
└── ─── INTEGRAÇÕES EXTERNAS ────────────────────────────────────────────────

    integrations/                    # Clientes HTTP para APIs externas
    ├── integrations.module.ts       # opcional — apenas para documentar dependências
    ├── hinova/
    │   └── hinova.client.ts         # wrapper Axios para SGA Hinova
    ├── softruck/
    │   └── softruck.client.ts
    ├── m7/
    │   └── m7.client.ts
    ├── alloyal/
    │   └── alloyal.client.ts
    ├── clubgas/
    │   └── clubgas.client.ts
    └── expo/
        └── expo-push.client.ts
```

---

## 3. Regras arquiteturais

### 3.1 Regras de dependência entre módulos

```
REGRA 1 — Encapsulamento obrigatório
  ✅ Um módulo só pode usar o que outro módulo EXPORTA
  ❌ Nunca importe uma classe diretamente de outro contexto de domínio

  // ERRADO
  import { SgaService } from 'src/sga/sga.service';
  providers: [SgaService]

  // CORRETO
  @Module({ imports: [SgaModule] })  // SgaModule exporta SgaService
  
REGRA 2 — Infraestrutura é global, domínio não é
  ✅ DatabaseModule, InfraModule, SharedModule, QueueModule, StorageModule → @Global()
  ❌ Módulos de domínio NUNCA devem ser @Global()

REGRA 3 — Domínio não depende de domínio diretamente
  ✅ auth → AuthModule (infra)
  ✅ reinspection → SgaModule (via import do módulo)
  ❌ reinspection → NotificationsModule (use event interno ou fila)
  
  Exceção aceita: módulos que têm dependência de negócio clara e explícita
  (ex: FuelSessionModule importar EconomiaModule está OK)

REGRA 4 — Guards são infraestrutura, não domínio
  ✅ Guards residem em InfraModule
  ❌ Guard não deve morar no módulo de negócio que o originou

REGRA 5 — PrismaService é injetado, não instanciado
  ✅ Constructor recebe PrismaService via DI (DatabaseModule global)
  ❌ Nunca declare PrismaService em providers de módulos de domínio

REGRA 6 — Sem imports absolutos misturados com relativos
  ✅ import { X } from 'src/database/prisma.service'   (path alias)
  ✅ import { X } from '../database/prisma.service'    (relativo)
  ❌ Misturar os dois estilos no mesmo projeto

REGRA 7 — Filas são consumidas por Processors no mesmo módulo
  ✅ NotificationProcessor está em notifications/
  ✅ BoletoVerificacaoProcessor está em sga/boleto/
  ❌ Processor de um domínio não deve residir em outro módulo
```

### 3.2 Organização de DTOs

```
REGRA — DTOs ficam em dto/ dentro do módulo que os utiliza

src/reinspection/dto/
  create-reinspection.dto.ts    # input do controller
  list-reinspections.dto.ts     # query params
  reinspection-response.dto.ts  # output tipado (opcional)

Tipos compartilhados entre módulos → src/shared/types/ ou inline no módulo exportador
Nunca importe DTO de outro módulo de domínio — duplique se necessário
```

### 3.3 Organização de interfaces e tipos

```
src/auth/interfaces/jwt-user.interface.ts     → tipos do payload JWT
src/shared/types/base-origin.type.ts          → tipos multi-tenant
src/storage/interfaces/storage.interface.ts   → contrato da abstração de storage
```

### 3.4 Como evitar acoplamento circular

```
Sintoma: ModuleA importa ModuleB que importa ModuleA → NestJS lança erro
Causa comum: guard ou service que depende de dois domínios simultaneamente

Solução 1 (preferida): mover a dependência compartilhada para InfraModule
Solução 2: usar forwardRef() apenas quando inevitável
Solução 3: emitir evento via EventEmitter2 (desacopla chamada)

// Usando EventEmitter2 para quebrar dependência circular
// reinspection.service.ts
this.eventEmitter.emit('reinspection.submitted', { reinspectionId, userId });

// notifications.service.ts
@OnEvent('reinspection.submitted')
async handleReinspectionSubmitted(payload: { reinspectionId: number; userId: number }) { ... }
```

---

## 4. Como melhorar o AppModule

### 4.1 AppModule atual (problema)

```typescript
// ATUAL: AppModule com providers inline, controllers soltos e lógica misturada
@Module({
  imports: [QueueModule, AuthModule, ...],
  controllers: [
    PostosController,    // ← sem módulo!
    CartaoController,    // ← sem módulo!
    EconomiaController,  // ← sem módulo!
    SgaController,       // ← sem módulo!
    BoletoController,    // ← sem módulo!
  ],
  providers: [
    PrismaService,       // ← redeclarado aqui e em 12 outros módulos
    MailService,         // ← redeclarado aqui e no ReinspectionModule
    SgaService,          // ← sem módulo encapsulador
    ...
  ],
})
```

### 4.2 AppModule alvo

```typescript
// ALVO: AppModule como orchestrator puro — sem providers nem controllers diretos
@Module({
  imports: [
    // ── Infraestrutura global (ordem importa) ────────────────────
    DatabaseModule,     // @Global() — PrismaService
    InfraModule,        // @Global() — guards, interceptors, MailService
    StorageModule,      // @Global() — StorageService
    SharedModule,       // @Global() — multi-tenancy
    QueueModule,        // @Global() — BullMQ

    // ── Domínios ─────────────────────────────────────────────────
    AuthModule,
    AdminPanelModule,
    AssociadoModule,
    SgaModule,          // exporta SgaService (consumido por Reinspection)
    ReinspectionModule,
    RastreamentoModule,
    NotificationsModule,
    BeneficiosModule,
    PostosModule,       // ← criado na refatoração
    CartaoModule,       // ← criado na refatoração
    EconomiaModule,     // ← criado na refatoração
    FuelSessionModule,
    OficinaModule,
    DocumentosModule,
    SliderModule,
  ],
  // Sem controllers. Sem providers. Apenas importações.
})
export class AppModule {}
```

### 4.3 Bootstrap limpo (main.ts)

```typescript
async function bootstrap() {
  validateEnvOrThrow(); // lança antes de criar a app

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Segurança
  app.use(helmet());
  app.enableCors({ origin: true, credentials: true, ... });

  // Limites de payload (fotos base64)
  app.use(json({ limit: '20mb' }));
  app.use(urlencoded({ extended: true, limit: '20mb' }));

  // Validação global
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Interceptor de log global
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Filtro de exceção global
  app.useGlobalFilters(new HttpExceptionFilter());

  // Prefixo de versão
  app.setGlobalPrefix('api/v1');

  // Arquivos estáticos
  app.useStaticAssets(join(__dirname, '..', 'uploads'), { prefix: '/uploads/' });

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('Benefícios API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  await app.listen(process.env.PORT ?? 3001);
}
```

---

## 5. Como melhorar a autenticação

### 5.1 Problema atual

Ambos os sistemas de auth (mobile e admin) usam:
- O mesmo `JWT_SECRET`
- O mesmo `JwtStrategy`
- O mesmo `JwtAuthGuard`

Isso faz com que um token de usuário mobile (expira em 300d) tecnicamente passe na validação de `JwtAuthGuard` em rotas admin, com o `AdminPanelRoleGuard` como única barreira.

### 5.2 Solução recomendada — separar audiences no JWT

```typescript
// auth/auth.module.ts — JWT de usuário mobile
JwtModule.register({
  secret: process.env.JWT_SECRET,
  signOptions: {
    expiresIn: '300d',
    audience: 'mobile-app',   // ← adicionar audience
    issuer: 'beneficios-api',
  },
})

// admin-panel/admin-panel.module.ts — JWT de admin
JwtModule.register({
  secret: process.env.JWT_SECRET,  // pode ser o mesmo secret...
  signOptions: {
    expiresIn: '1d',
    audience: 'admin-panel',       // ...mas audience diferente separa os tokens
    issuer: 'beneficios-api',
  },
})
```

```typescript
// infra/guards/jwt-auth.guard.ts — rejeita tokens admin em rotas mobile
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any, info: any) {
    if (err || !user) throw err || new UnauthorizedException();
    // Rejeita token com audience='admin-panel' em rotas protegidas pelo guard mobile
    if (user.audience === 'admin-panel') {
      throw new ForbiddenException('Token inválido para este contexto');
    }
    return user;
  }
}

// infra/guards/admin-jwt.guard.ts — guard específico para rotas admin
@Injectable()
export class AdminJwtGuard extends AuthGuard('admin-jwt') {} // strategy separada
```

### 5.3 AdminPanelRoleGuard — remover query N+1

O problema atual: o guard faz **query ao banco em toda request admin** para buscar o `AdminPanelUser` pelo email.

Solução: incluir o `AdminPanelRole` no payload do JWT no momento do login:

```typescript
// admin-panel/auth/admin-auth.service.ts
async login(data: AdminPanelLoginDto) {
  const adminUser = await this.prisma.adminPanelUser.findUnique({ ... });
  // ...bcrypt.compare...

  const payload = {
    sub: adminUser.id,
    email: adminUser.email,
    username: adminUser.name,
    role: 'ADMIN',
    adminRole: adminUser.role,   // ← INCLUIR o papel específico no JWT
    audience: 'admin-panel',
  };

  return { access_token: this.jwtService.sign(payload) };
}
```

```typescript
// infra/guards/admin-panel-role.guard.ts — ZERO query ao banco
@Injectable()
export class AdminPanelRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}  // sem PrismaService!

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AdminPanelRole[]>(
      ADMIN_PANEL_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles?.length) return true;

    const { user } = context.switchToHttp().getRequest();

    if (!user) throw new UnauthorizedException();
    if (user.role !== 'ADMIN') throw new ForbiddenException('Apenas administradores');

    // adminRole vem do JWT — sem query ao banco!
    if (!requiredRoles.includes(user.adminRole)) {
      throw new ForbiddenException('Perfil sem permissão para este recurso');
    }

    return true;
  }
}
```

**Benefício:** elimina 1 query de banco por request admin. Com 100 requests/min admin, isso elimina 100 queries desnecessárias por minuto.

### 5.4 Estrutura de roles recomendada

```
UserRole (usuário mobile): USER | ADMIN
  └── ADMIN permite acesso a rotas com AdminRoleGuard

AdminPanelRole (painel): REVISTORIA | EVENTOS | MARKETING | COBRANCA
  └── Validado pelo AdminPanelRoleGuard via JWT payload (adminRole)
  └── Não requer query ao banco após login

Fluxo:
  1. Login admin → JWT com { role: 'ADMIN', adminRole: 'REVISTORIA' }
  2. Request → JwtAuthGuard valida assinatura + audience
  3. Request → AdminPanelRoleGuard verifica req.user.adminRole (zero query)
```

---

## 6. Como melhorar o Prisma

### 6.1 DatabaseModule global

```typescript
// src/database/database.module.ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
```

```typescript
// src/database/prisma.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { level: 'query', emit: 'event' },
        { level: 'error', emit: 'stdout' },
        { level: 'warn',  emit: 'stdout' },
      ],
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');

    // Log de queries lentas (> 500ms) em desenvolvimento
    if (process.env.NODE_ENV !== 'production') {
      (this as any).$on('query', (e: { duration: number; query: string }) => {
        if (e.duration > 500) {
          this.logger.warn(`Slow query (${e.duration}ms): ${e.query}`);
        }
      });
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  // Helper para transações tipadas
  async transaction<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.$transaction(fn as any);
  }
}
```

### 6.2 Remover PrismaService de todos os módulos de domínio

```typescript
// ANTES: cada módulo declara PrismaService
@Module({
  providers: [ReinspectionService, PrismaService],  // ← remover
})

// DEPOIS: DatabaseModule global, nenhum módulo precisa declarar
@Module({
  providers: [ReinspectionService],  // PrismaService injetado via DatabaseModule global
})
```

Isso elimina ~12 declarações redundantes de PrismaService em todo o projeto.

### 6.3 Evitar N+1 — padrões de select

```typescript
// ERRADO — busca dados e depois faz loop com queries individuais
const reinspections = await this.prisma.reinspection.findMany();
for (const r of reinspections) {
  const photos = await this.prisma.reinspectionPhoto.findMany({
    where: { reinspectionId: r.id },
  });
}

// CORRETO — include faz JOIN numa única query
const reinspections = await this.prisma.reinspection.findMany({
  include: {
    photos: true,
    userVehicle: { include: { user: { select: { name: true, cpf: true } } } },
  },
});

// PADRÃO para seleção de campos — sempre use select quando não precisa de tudo
const user = await this.prisma.user.findUnique({
  where: { id: userId },
  select: { id: true, cpf: true, baseOrigin: true },  // não busque passwordHash desnecessariamente
});
```

### 6.4 Transações para operações compostas

```typescript
// src/reinspection/reinspection.service.ts
async submitReinspection(reinspectionId: number) {
  return this.prisma.transaction(async (tx) => {
    const reinspection = await tx.reinspection.findUnique({ ... });
    // validações...
    await tx.reinspection.update({
      where: { id: reinspectionId },
      data: { status: 'EM_ANALISE' },
    });
    await tx.userVehicle.update({
      where: { id: reinspection.userVehicleId },
      data: { reinspectionRequired: false },
    });
    // Se qualquer operação falhar, toda a transação é revertida
    return reinspection;
  });
}
```

---

## 7. Como melhorar integrações externas

### 7.1 Padrão de client HTTP

Toda integração externa deve seguir este padrão:

```typescript
// src/integrations/hinova/hinova.client.ts
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class HinovaClient {
  private readonly logger = new Logger(HinovaClient.name);
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: 'https://api.hinova.com.br/api/sga/v2',
      timeout: 10_000,           // 10s timeout
      headers: { 'Content-Type': 'application/json' },
    });

    // Interceptor: log de request
    this.http.interceptors.request.use((config) => {
      this.logger.log(`→ ${config.method?.toUpperCase()} ${config.url}`);
      return config;
    });

    // Interceptor: log de response + erro
    this.http.interceptors.response.use(
      (res) => {
        this.logger.log(`← ${res.status} ${res.config.url}`);
        return res;
      },
      (err) => {
        const status = err.response?.status;
        const url = err.config?.url;
        this.logger.error(`← ERRO ${status ?? 'sem resposta'} ${url}: ${err.message}`);
        return Promise.reject(err);
      },
    );
  }

  async buscarAssociado(cpf: string, bearerToken: string) {
    const res = await this.http.get(`/associado/buscar/${cpf}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      validateStatus: () => true,  // não lança erro em 4xx/5xx — trata no caller
    });
    return res.data;
  }
}
```

### 7.2 Retry com backoff exponencial

Para chamadas críticas (ex: envio para Hinova), adicionar retry simples sem biblioteca externa:

```typescript
// src/shared/utils/retry.util.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries: number; delayMs: number; logger?: { warn: (m: string) => void } },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      options.logger?.warn(`Tentativa ${attempt}/${options.retries} falhou. Retry em ${options.delayMs}ms`);
      if (attempt < options.retries) {
        await new Promise((r) => setTimeout(r, options.delayMs * attempt)); // backoff linear
      }
    }
  }
  throw lastError;
}

// Uso:
const data = await withRetry(
  () => this.hinovaClient.buscarAssociado(cpf, token),
  { retries: 3, delayMs: 500, logger: this.logger },
);
```

### 7.3 Cache de token SGA (já existe — melhorar)

O `SgaAuthService` já tem cache em memória. Manter e garantir que é único no sistema (via `DatabaseModule` global → `SgaAuthService` é singleton).

```typescript
// src/shared/sga-auth.service.ts — padrão atual está correto
// Garantir que SgaAuthService seja singleton: SharedModule @Global() já garante isso
```

### 7.4 Tabela de contratos por integração

| Integração | Client | Timeout | Retry | Auth |
|---|---|---|---|---|
| Hinova SGA | `HinovaClient` | 10s | 3x backoff linear | Bearer (cache em memória) |
| Softruck | `SoftruckClient` | 15s | 2x | Bearer por BaseOrigin |
| M7 | `M7Client` | 15s | 2x | Bearer por BaseOrigin |
| Alloyal | `AlloyalClient` | 10s | 2x | API Secret por BaseOrigin |
| ClubGas | `ClubGasClient` | 10s | 2x | Bearer por BaseOrigin |
| Expo Push | `ExpoPushClient` | 30s | filas BullMQ | Server SDK |
| Gmail SMTP | `MailService` | 30s | 1x | App Password |

---

## 8. Como melhorar filas e jobs

### 8.1 Organização ideal das filas

```typescript
// src/queue/queue.constants.ts — constantes centralizadas
export const Queues = {
  WEBHOOK:            'webhook-events',
  NOTIFICATIONS:      'notifications',
  FUEL_ECONOMY:       'fuel-economy',
  BOLETO_VERIFICACAO: 'boleto-verificacao',
} as const;

export type QueueName = typeof Queues[keyof typeof Queues];
```

```typescript
// src/queue/queue.module.ts
@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT) ?? 6379,
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 100 },   // mantém últimos 100 jobs completos
        removeOnFail: { count: 500 },        // mantém últimos 500 jobs falhos para debug
      },
    }),
    BullModule.registerQueue(
      { name: Queues.WEBHOOK },
      { name: Queues.NOTIFICATIONS },
      { name: Queues.FUEL_ECONOMY },
      { name: Queues.BOLETO_VERIFICACAO },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
```

### 8.2 Padrão de Processor com retry e dead-letter

```typescript
// src/notifications/notification.processor.ts
@Processor(Queues.NOTIFICATIONS, {
  concurrency: 3,
  limiter: { max: 10, duration: 1000 },  // max 10 jobs/s por worker
})
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(private readonly notificationsService: NotificationsService) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    const start = Date.now();
    this.logger.log(
      `[JOB] #${job.id} | queue=${Queues.NOTIFICATIONS} | attempt=${job.attemptsMade + 1}`,
    );

    try {
      await this.notificationsService.sendPushNotification(
        job.data.userId,
        job.data.expoPushToken,
        job.data.title,
        job.data.body,
        job.data.data,
      );
      this.logger.log(`[JOB] #${job.id} ✔ ${Date.now() - start}ms`);
    } catch (err) {
      this.logger.error(`[JOB] #${job.id} ✘ ${(err as Error).message}`);
      throw err; // lança para BullMQ gerenciar o retry
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
      // Job esgotou todas as tentativas — registrar para alertas futuros
      this.logger.error(
        `[DEAD LETTER] Job #${job.id} falhou definitivamente: ${error.message}`,
      );
    }
  }
}
```

### 8.3 Idempotência em processors

```typescript
// Estratégia: usar job.id ou dado único como chave de idempotência
async process(job: Job<BoletoVerificacaoJobData>) {
  const idempotencyKey = `boleto:${job.data.nossoNumero}`;

  // Verificar se já foi processado (ex: job duplicado na fila)
  const payment = await this.prisma.reinspectionPayment.findUnique({
    where: { nossoNumero: job.data.nossoNumero },
    select: { pago: true },
  });

  if (payment?.pago) {
    this.logger.log(`[JOB] ${idempotencyKey} já processado — skipping`);
    return; // retorna sem erro, job considerado completo
  }

  // Processar normalmente...
}
```

### 8.4 Bull Board (UI de monitoramento — opcional)

```typescript
// src/infra/bull-board.setup.ts
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';

export function setupBullBoard(app: NestExpressApplication, queues: Queue[]) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues: queues.map((q) => new BullMQAdapter(q)),
    serverAdapter,
  });

  app.use('/admin/queues', serverAdapter.getRouter());
}
// Proteger essa rota com um middleware de autenticação básica antes de habilitar!
```

---

## 9. Como melhorar uploads

### 9.1 StorageService — abstração para trocar backend sem mudar consumidores

```typescript
// src/storage/storage.service.ts
export interface UploadResult {
  path: string;   // path relativo interno
  url: string;    // URL pública acessível
}

export abstract class StorageService {
  abstract upload(
    buffer: Buffer,
    filename: string,
    folder: string,
  ): Promise<UploadResult>;

  abstract delete(path: string): Promise<void>;

  abstract getPublicUrl(path: string): string;
}
```

```typescript
// src/storage/providers/local-storage.provider.ts
@Injectable()
export class LocalStorageProvider extends StorageService {
  private readonly baseDir = join(process.cwd(), 'uploads');
  private readonly baseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3001';

  async upload(buffer: Buffer, filename: string, folder: string): Promise<UploadResult> {
    const dir = join(this.baseDir, folder);
    await fs.mkdir(dir, { recursive: true });

    const timestamp = Date.now();
    const safeFilename = this.sanitize(filename);
    const finalName = `${timestamp}-${safeFilename}`;
    const fullPath = join(dir, finalName);

    await fs.writeFile(fullPath, buffer);

    const relativePath = `${folder}/${finalName}`;
    return {
      path: relativePath,
      url: `${this.baseUrl}/uploads/${relativePath}`,
    };
  }

  async delete(path: string): Promise<void> {
    await fs.unlink(join(this.baseDir, path)).catch(() => {
      // arquivo não encontrado — não é erro crítico
    });
  }

  getPublicUrl(path: string): string {
    return `${this.baseUrl}/uploads/${path}`;
  }

  private sanitize(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
  }
}
```

```typescript
// src/storage/storage.module.ts
@Global()
@Module({
  providers: [
    {
      provide: StorageService,
      useClass: process.env.STORAGE_PROVIDER === 's3'
        ? S3StorageProvider         // futuramente
        : LocalStorageProvider,     // padrão atual
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
```

```typescript
// src/reinspection/reinspection.service.ts — consumidor sem conhecer implementação
constructor(private readonly storage: StorageService) {}

const result = await this.storage.upload(buffer, filename, 'reinspection-photos');
// result.url é a URL pública — não muda se migrar para S3
```

### 9.2 Volume Docker compartilhado

```yaml
# docker-compose.yml
services:
  api:
    volumes:
      - uploads-data:/app/uploads   # volume nomeado compartilhado
      
volumes:
  uploads-data:
    driver: local
```

Quando migrar para S3, remover o volume e adicionar env `STORAGE_PROVIDER=s3` + credenciais AWS. Os consumidores do `StorageService` não precisam de nenhuma mudança.

### 9.3 URLs públicas configuráveis

```bash
# .env
APP_BASE_URL=https://api.seudominio.com.br
# URLs de uploads ficam: https://api.seudominio.com.br/uploads/reinspection-photos/123.jpg
```

---

## 10. Como melhorar observabilidade

### 10.1 LoggingInterceptor com requestId

```typescript
// src/infra/interceptors/logging.interceptor.ts
import {
  Injectable, NestInterceptor, ExecutionContext,
  CallHandler, Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { randomUUID } from 'crypto';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    // Gerar requestId único para correlacionar logs da mesma request
    const requestId = randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const { method, url } = req;
    const userId = req.user?.userId ?? 'anon';
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - start;
          const statusCode = res.statusCode;
          this.logger.log(
            JSON.stringify({
              requestId,
              method,
              url,
              statusCode,
              duration,
              userId,
            }),
          );
        },
        error: (err) => {
          const duration = Date.now() - start;
          this.logger.error(
            JSON.stringify({
              requestId,
              method,
              url,
              statusCode: err.status ?? 500,
              duration,
              userId,
              error: err.message,
            }),
          );
        },
      }),
    );
  }
}
```

### 10.2 HttpExceptionFilter padronizado

```typescript
// src/infra/filters/http-exception.filter.ts
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();

    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    res.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: req.url,
      requestId: req.requestId,
      message:
        typeof exceptionResponse === 'object'
          ? (exceptionResponse as any).message
          : exceptionResponse,
    });
  }
}
```

### 10.3 Health check endpoint

```typescript
// src/infra/health/health.controller.ts
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    const start = Date.now();

    // Ping no banco de dados
    let dbOk = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch { /* db offline */ }

    return {
      status: dbOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {
        database: dbOk ? 'ok' : 'error',
      },
      responseTimeMs: Date.now() - start,
    };
  }
}
```

```yaml
# docker-compose.yml — healthcheck do container
services:
  api:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/api/v1/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
```

### 10.4 Log de integrações externas

```typescript
// Padrão para logs de chamadas externas — usar em todos os clients
this.logger.log(
  JSON.stringify({
    type: 'external_call',
    integration: 'hinova-sga',
    method: 'GET',
    endpoint: '/associado/buscar',
    baseOrigin,
    duration,
    statusCode: res.status,
  }),
);
```

### 10.5 Estratégia de armazenamento de logs

```bash
# Rotação de logs na VPS — sem stack enterprise
/etc/logrotate.d/beneficios-api:
  /var/log/beneficios-api/*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
  }
```

Para coleta futura: Loki (self-hosted, baixo custo) + Grafana. Um compose file adicional resolve.

---

## 11. Roadmap pragmático

### Curto prazo — Semanas 1 a 3 (Fundação)

| # | Tarefa | Impacto | Risco | Esforço | Prioridade |
|---|---|---|---|---|---|
| 1 | Criar `DatabaseModule` @Global + eliminar PrismaService dos módulos | Alto | Baixo | 2h | 🔴 Crítico |
| 2 | Criar `InfraModule` @Global + mover `AdminPanelRoleGuard`, `MailService` | Alto | Baixo | 3h | 🔴 Crítico |
| 3 | Criar `SgaModule` com exports — remover SgaService do ReinspectionModule | Alto | Baixo | 2h | 🔴 Crítico |
| 4 | Criar `PostosModule`, `CartaoModule`, `EconomiaModule` | Médio | Baixo | 4h | 🟠 Alta |
| 5 | Corrigir `FuelSessionModule` — importar `EconomiaModule` ao invés de classe | Médio | Baixo | 1h | 🟠 Alta |
| 6 | `AdminPanelRoleGuard` — incluir `adminRole` no JWT payload (sem query ao banco) | Alto | Baixo | 3h | 🟠 Alta |
| 7 | Expandir `env.validator.ts` para todas as variáveis | Alto | Baixo | 2h | 🟠 Alta |
| 8 | Adicionar `LoggingInterceptor` + `HttpExceptionFilter` globais | Alto | Baixo | 3h | 🟠 Alta |
| 9 | Criar `StorageService` abstrato + `LocalStorageProvider` | Médio | Baixo | 4h | 🟡 Média |
| 10 | Health check endpoint `GET /api/v1/health` | Médio | Baixo | 1h | 🟡 Média |

### Médio prazo — Semanas 4 a 6 (Consolidação)

| # | Tarefa | Impacto | Risco | Esforço | Prioridade |
|---|---|---|---|---|---|
| 11 | Adicionar `audience` nos JWTs para separar contextos de auth | Alto | Médio | 3h | 🟠 Alta |
| 12 | Adicionar `app.setGlobalPrefix('api/v1')` + atualizar app mobile | Alto | **Médio (breaking)** | 3h | 🟠 Alta |
| 13 | Criar clients HTTP padronizados em `src/integrations/` | Alto | Baixo | 8h | 🟡 Média |
| 14 | Adicionar retry util + aplicar em chamadas críticas (Hinova, Softruck) | Alto | Baixo | 4h | 🟡 Média |
| 15 | Padronizar `defaultJobOptions` no QueueModule (retry, backoff, cleanup) | Médio | Baixo | 2h | 🟡 Média |
| 16 | Organizar `AppModule` para ter zero providers e zero controllers inline | Médio | Baixo | 2h | 🟡 Média |
| 17 | Adicionar `select` explícito nas queries Prisma críticas (evitar N+1) | Médio | Baixo | 4h | 🟡 Média |
| 18 | Criar `StorageModule` global com provider local | Médio | Baixo | 3h | 🟡 Média |

### Longo prazo — Trimestre 2 (Evolução)

| # | Tarefa | Impacto | Risco | Esforço | Prioridade |
|---|---|---|---|---|---|
| 19 | Configurar Bull Board protegido para monitorar filas via UI | Médio | Baixo | 3h | 🟢 Baixa |
| 20 | Adicionar logs estruturados JSON + logrotate na VPS | Médio | Baixo | 2h | 🟢 Baixa |
| 21 | Avaliar migração de uploads para S3 compatível (ex: Cloudflare R2) | Alto | Médio | 8h | 🟢 Baixa (quando necessário) |
| 22 | Adicionar testes de integração nos módulos críticos (reinspection, auth) | Alto | Baixo | 16h | 🟢 Baixa |
| 23 | Avaliar `@nestjs/config` + `ConfigModule` para substituir `process.env` direto | Baixo | Baixo | 4h | 🟢 Baixa |
| 24 | Avaliar Loki + Grafana self-hosted para logs centralizados | Médio | Baixo | 6h | 🟢 Baixa (quando tiver volume) |

---

## Apêndice — Exemplo completo de módulo refatorado

### SgaModule (antes → depois)

**Antes:**
```typescript
// Não existia SgaModule. SgaService estava em:
// - providers: [] do AppModule
// - providers: [] do ReinspectionModule (cópia direta)
```

**Depois:**
```typescript
// src/sga/sga.module.ts
@Module({
  controllers: [SgaController, BoletoController],
  providers: [
    SgaService,
    BoletoService,
    BoletoVerificacaoProcessor,
  ],
  exports: [SgaService],  // ← único ponto de acesso externo
})
export class SgaModule {}

// src/reinspection/reinspection.module.ts
@Module({
  imports: [SgaModule],   // ← importa o módulo, usa o export
  controllers: [ReinspectionController, ReinspectionPaymentsAdminController],
  providers: [ReinspectionService, ReinspectionPaymentsAdminService],
  // PrismaService, MailService, AdminPanelRoleGuard, FileUploadService
  // → vêm dos módulos globais — não precisam ser declarados aqui
})
export class ReinspectionModule {}
```

### Comparação do ReinspectionModule

| Item | Antes | Depois |
|---|---|---|
| Providers declarados | 6 (Prisma, File, Mail, Guard, Sga, Service) | 2 (apenas os próprios) |
| Dependências explícitas | 0 módulos importados | 1 módulo (SgaModule) |
| Acoplamento com AdminPanel | Direto (importação de classe) | Via InfraModule global |
| Testabilidade | Difícil (muitas dependências manuais) | Fácil (mock DatabaseModule) |
