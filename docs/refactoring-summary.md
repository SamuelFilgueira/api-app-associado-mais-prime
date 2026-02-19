# Refactoring Summary

> Revisão estrutural da API NestJS - Proteção Veicular  
> Data: 19/02/2026

---

## 1. O que foi melhorado

### 1.1 PrismaService — Lifecycle adequado

**Arquivo:** `src/prisma.service.ts`

- Implementado `OnModuleInit` e `OnModuleDestroy` para gerenciamento correto do ciclo de vida da conexão com o banco de dados.
- Anteriormente, `PrismaService` era apenas `extends PrismaClient` sem controle de conexão/desconexão, arriscando conexões órfãs em produção.

### 1.2 Substituição global de `console.log` por NestJS `Logger`

**Arquivos afetados (17 arquivos):**
- `src/associado/associado.controller.ts`
- `src/associado/associado.service.ts`
- `src/postos/postos.controller.ts`
- `src/postos/postos.service.ts`
- `src/cartao/cartao.service.ts`
- `src/sga/boleto/boleto.controller.ts`
- `src/sga/boleto/boleto.service.ts`
- `src/rastreamento/rastreamento.controller.ts`
- `src/rastreamento/rastreamento.service.ts`
- `src/rastreamento/rastreamento-m7.ts`
- `src/rastreamento/rastreamento-softruck.ts`
- `src/notifications/notifications.controller.ts`
- `src/common/services/file-upload.service.ts`

**Por quê:** `console.log` não é adequado para produção. O `Logger` do NestJS:
- Permite configurar níveis de log (debug/log/warn/error)
- Identifica automaticamente o contexto (nome da classe)
- É integrável com ferramentas de observabilidade (Datadog, CloudWatch, etc.)
- Não expõe dados sensíveis inadvertidamente (tokens, dados de cartão, etc.)

### 1.3 Remoção de injeção não utilizada — `OficinaController`

**Arquivo:** `src/oficina/oficina.controller.ts`

- Removida injeção de `PrismaService` no construtor do controller. O controller delegava todas as operações ao `OficinaService`, tornando a dependência direta do Prisma desnecessária e uma violação de separação de responsabilidades.

### 1.4 Remoção de método não utilizado — `AlloyalApiService.get()`

**Arquivo:** `src/beneficios/alloyal-api.service.ts`

- Removido método genérico `get<T>()` que nunca era chamado. Todos os métodos do service utilizam `makeAuthenticatedRequest()` com retry automático, tornando o método `get()` redundante e código morto.

### 1.5 Correção de query duplicada — `NotificationsService`

**Arquivo:** `src/notifications/notifications.service.ts`

- Em `getUnreadNotifications()`, eram feitas 3 queries no `Promise.all`, sendo que `total` e `unreadCount` executavam exatamente a mesma query. Reduzido para 2 queries, eliminando o custo desnecessário ao banco.

---

## 2. Onde havia boilerplate

### 2.1 Normalização de telefone duplicada — `OficinaService`

**Arquivo:** `src/oficina/oficina.service.ts`

- A lógica de adicionar prefixo `+55` a `phone`, `phoneSecondary` e `whatsapp` estava duplicada identicamente em `createWorkshop()` e `updateWorkshop()`.
- **Solução:** Extraído para método privado `normalizePhoneNumbers()`.

### 2.2 Lookup de coordenadas por CEP duplicado — `OficinaService`

**Arquivo:** `src/oficina/oficina.service.ts`

- A chamada à API CepAberto para buscar latitude/longitude a partir do CEP estava duplicada (com tratamento de erro) em `createWorkshop()` e `updateWorkshop()`.
- **Solução:** Extraído para método privado `lookupCepCoordinates()`.

### 2.3 Normalização de serviços inline — `OficinaService`

**Arquivo:** `src/oficina/oficina.service.ts`

- O trimming e filtragem de arrays de serviços estava feito inline em ambos os métodos, sendo que `normalizeServices()` já existia como método privado.
- **Solução:** Substituído o código inline por chamada ao método existente `normalizeServices()`.

### 2.4 Mapeamento de organizações duplicado (4x) — `AlloyalApiService`

**Arquivo:** `src/beneficios/alloyal-api.service.ts`

- O mapeamento de dados de organização (id, name, cover_picture, etc.) era repetido identicamente em 4 métodos: `getOrganizations()`, `getNearestOrganizations()`, `getHighlightsNearby()` e `getHighlightsOnline()`.
- **Solução:** Extraído para método privado `mapOrganization(org, includeDistance)`.

### 2.5 Busca de usuário + chamada SGA duplicada — `SgaService`

**Arquivo:** `src/sga/sga.service.ts`

- As operações de buscar o usuário, validar CPF, limpar caracteres e chamar a API Hinova/SGA eram idênticas entre `consultarAssociado()` e `consultarVeiculosAssociado()`.
- **Solução:** Extraídos métodos privados `getUserCpf()` e `fetchSgaAssociado()`.

---

## 3. O que foi padronizado

| Aspecto | Antes | Depois |
|---------|-------|--------|
| **Logging** | `console.log` em ~17 arquivos | `Logger` do NestJS em todos os arquivos |
| **Contexto de log** | Strings manuais (`[Softruck]`, `[M7]`, etc.) | `Logger` com nome da classe automático |
| **Nível de log** | Tudo como `console.log` | `log`, `warn`, `error`, `debug` conforme severidade |
| **Lifecycle do Prisma** | Sem gerenciamento | `OnModuleInit` + `OnModuleDestroy` |
| **CEP lookup** | Código duplicado (30+ linhas x2) | Método centralizado `lookupCepCoordinates()` |
| **Phone normalization** | Código duplicado (15+ linhas x2) | Método centralizado `normalizePhoneNumbers()` |
| **Org mapping** | Código duplicado (~15 linhas x4) | Método centralizado `mapOrganization()` |

---

## 4. Pontos de escalabilidade resolvidos

1. **Logger configurável** — Permite integração futura com serviços de monitoramento sem alterar código de negócio.
2. **PrismaService lifecycle** — Garante liberação de conexões ao desligar a aplicação. Crítico para ambientes com connection pooling.
3. **Helpers reutilizáveis em OficinaService** — Novos métodos de CRUD em oficinas podem usar `normalizePhoneNumbers()` e `lookupCepCoordinates()` sem duplicar código.
4. **`mapOrganization()` centralizado** — Novos endpoints de organizações Alloyal podem reutilizar o mapeamento padronizado.
5. **`getUserCpf()` e `fetchSgaAssociado()`** — Novas consultas ao SGA podem reutilizar esses helpers sem duplicar a lógica de busca/validação.

---

## 5. Sugestões futuras (não aplicadas)

### 5.1 Módulos para controllers/services órfãos no AppModule

`PostosController`/`PostosService`, `CartaoController`/`CartaoService`, `EconomiaController`/`EconomiaService`, `SgaController`/`SgaService` e `BoletoController`/`BoletoService` estão registrados diretamente no `AppModule` sem módulos próprios. Criar módulos dedicados (`PostosModule`, `CartaoModule`, etc.) melhoraria a organização e permitiria lazy loading futuro.

### 5.2 PrismaModule global

`PrismaService` está registrado independentemente em 7 módulos diferentes, criando múltiplas instâncias. Recomenda-se criar um `PrismaModule` com `@Global()` e registrar o `PrismaService` como singleton.

```typescript
// Exemplo sugerido:
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

### 5.3 FileUploadModule global

Assim como o PrismaService, o `FileUploadService` está registrado em múltiplos módulos (`AssociadoModule`, `OficinaModule`). Centralizá-lo em um módulo compartilhado evitaria instâncias duplicadas.

### 5.4 Credenciais hardcoded no AlloyalApiService

Em `alloyal-api.service.ts`, as credenciais de login (`cpf` e `password`) estão hardcoded no método `login()`. Recomenda-se movê-las para variáveis de ambiente:
```
ALLOYAL_CPF=...
ALLOYAL_PASSWORD=...
```

### 5.5 Shared helper para "buscar usuário e validar campo"

Os serviços `PostosService`, `CartaoService`, `EconomiaService` e `SgaService` repetem o padrão:
```typescript
const user = await this.prisma.user.findUnique({ where: { id: userId } });
if (!user || !user.cpf) throw new NotFoundException('...');
```
Isso poderia ser extraído para um `UserLookupService` ou mixin compartilhado.

### 5.6 AlloyalApiController duplicado

`AlloyalApiController` está registrado tanto no `AlloyalApiModule` (via service export) quanto diretamente em `AppModule.controllers`. Isso pode causar registro duplo.

### 5.7 Variáveis de ambiente tipadas com `ConfigModule`

Múltiplos serviços acessam `process.env` diretamente. Usar `@nestjs/config` com `ConfigService` e validação via `Joi` ou `class-validator` garantiria que variáveis obrigatórias estejam presentes ao iniciar a aplicação.

### 5.8 DTOs de resposta para SGA e APIs externas

As respostas das APIs externas (Hinova, ClubGas, M7) retornam dados sem tipagem. Criar DTOs de resposta garantiria contratos mais seguros e documentação Swagger automática.

### 5.9 Imports não utilizados

- `boleto.service.ts`: importa `PrismaService` mas não injeta/usa.
- Outros arquivos podem ter imports residuais que um linter com regra `no-unused-imports` detectaria.

### 5.10 HttpModule do NestJS em vez de axios direto

Diversos serviços usam `axios` diretamente. O `HttpModule` (wrapper oficial do NestJS sobre axios) permitiria injeção de dependência, interceptors configuráveis e testabilidade facilitada com mocks.

---

## 6. Resumo das alterações por arquivo

| Arquivo | Tipo de alteração |
|---------|-------------------|
| `src/prisma.service.ts` | + OnModuleInit/OnModuleDestroy + Logger |
| `src/oficina/oficina.controller.ts` | - PrismaService injection (dead code) |
| `src/oficina/oficina.service.ts` | + normalizePhoneNumbers(), lookupCepCoordinates() helpers |
| `src/beneficios/alloyal-api.service.ts` | + mapOrganization() helper, - get() dead method |
| `src/sga/sga.service.ts` | + getUserCpf(), fetchSgaAssociado() helpers + Logger |
| `src/notifications/notifications.service.ts` | - duplicate count query |
| `src/associado/associado.controller.ts` | console.log → Logger |
| `src/associado/associado.service.ts` | console.log → Logger |
| `src/postos/postos.controller.ts` | console.log → Logger |
| `src/postos/postos.service.ts` | console.log → Logger |
| `src/cartao/cartao.service.ts` | console.log → Logger |
| `src/sga/boleto/boleto.controller.ts` | console.log → Logger |
| `src/sga/boleto/boleto.service.ts` | console.log → Logger, - unused NotFoundException import |
| `src/rastreamento/rastreamento.controller.ts` | console.log → Logger |
| `src/rastreamento/rastreamento.service.ts` | console.log/error → Logger |
| `src/rastreamento/rastreamento-m7.ts` | console.log/error/warn → Logger |
| `src/rastreamento/rastreamento-softruck.ts` | console.log/error → Logger |
| `src/notifications/notifications.controller.ts` | console.log → Logger |
| `src/common/services/file-upload.service.ts` | console.warn → Logger |

**Total: 19 arquivos modificados, 0 alterações comportamentais.**
