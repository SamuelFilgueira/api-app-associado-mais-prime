# Atualizacao Obrigatoria do App - Implementacao Backend

## 1. Resumo

Foi implementado no backend um gate de versao minima para bloquear versoes antigas do app mobile (Android/iOS) via endpoint de validacao.

Endpoint implementado:
- Metodo: POST
- Rota interna no controller: /app-version/validate
- Rota efetiva da API (com prefixo global): /api/app-version/validate

O endpoint retorna `forceUpdate` para o app decidir se deve bloquear uso e exibir modal de atualizacao obrigatoria.

## 2. O que foi implementado

### 2.1 Banco de dados (Prisma + MySQL)

Foram adicionadas duas estruturas:

1. Tabela de politica de versao:
- `AppVersionPolicy`
- Guarda versoes minimas e configuracoes de bloqueio por plataforma.

2. Tabela de auditoria de validacao:
- `AppVersionValidationLog`
- Guarda requests, decisao (`blocked`) e motivo (`reason`).

Migration criada:
- `prisma/migrations/202607140001_app_version_gate/migration.sql`

Seeds iniciais incluidos na migration:
- Politica Android com `forceUpdateEnabled = false`
- Politica iOS com `forceUpdateEnabled = false`

Observacao importante:
- O guia original estava em PostgreSQL, mas este projeto usa MySQL com Prisma.
- A modelagem foi adaptada para MySQL mantendo a mesma regra de negocio.

### 2.2 Modulo App Version

Novo modulo criado em `src/app-version` com:

- `app-version.controller.ts`
  - Exposicao do endpoint POST /app-version/validate
  - Coleta metadados para log: requestId, userId (quando existir), ip, user-agent

- `app-version.service.ts`
  - Regras de validacao de versao
  - Comparacao semver para appVersion/runtimeVersion
  - Comparacao numerica para versionCode/buildNumber
  - Montagem de resposta no contrato esperado pelo app

- `app-version.repository.ts`
  - Busca da policy ativa
  - Cache em memoria da policy por plataforma
  - Timeout curto na consulta da policy
  - Persistencia de log de validacao

- DTOs:
  - `dto/validate-app-version.dto.ts`
  - `dto/validate-app-version-response.dto.ts`

Integracao no app principal:
- `src/app.module.ts` passou a importar `AppVersionModule`

Dependencia adicionada:
- `semver`

## 3. Logica geral de decisao

A ordem implementada no service segue a ideia do guia:

1. Buscar politica ativa por plataforma e janela efetiva.
2. Se der erro na consulta da policy:
   - fail-open (nao bloquear)
   - logar `reason = policy_lookup_error`
3. Se nao existir policy ativa:
   - nao bloquear
   - logar `reason = no_active_policy`
4. Se `forceUpdateEnabled = false`:
   - nao bloquear
   - logar `reason = force_update_disabled`
5. Se `forceUpdateEnabled = true`, avaliar bloqueio:
   - appVersion com semver
   - runtimeVersion com semver (quando policy definir minimo)
   - Android: versionCode numerico
   - iOS: buildNumber numerico
6. Se qualquer regra falhar, bloquear (`forceUpdate = true`) com title/message/storeUrl da policy.
7. Registrar sempre a decisao na tabela de logs (com `blocked` e `reason`).

## 4. Contrato de API implementado

### Request esperado

```json
{
  "platform": "android",
  "appVersion": "1.1.7",
  "runtimeVersion": "1.1.7",
  "versionCode": 42
}
```

### Response sem bloqueio

```json
{
  "forceUpdate": false,
  "title": "",
  "message": "",
  "minSupportedVersion": "1.1.7",
  "minSupportedRuntimeVersion": "1.1.7"
}
```

### Response com bloqueio

```json
{
  "forceUpdate": true,
  "title": "Atualizacao obrigatoria",
  "message": "Uma nova versao do app esta disponivel. Atualize para continuar.",
  "storeUrl": "https://play.google.com/store/apps/details?id=com.maisprime.vantagens",
  "minSupportedVersion": "1.1.8",
  "minSupportedRuntimeVersion": "1.1.8"
}
```

## 5. Regras importantes de validacao

### 5.1 Semver

- Comparacao com `semver.lt` (nao compara string bruta).
- Valor invalido vindo do cliente, com force update ativo, leva a bloqueio (fail-safe de versao).

### 5.2 Inteiros

- `versionCode` (Android) compara com inteiro.
- `buildNumber` (iOS) deve ser string numerica inteira (somente digitos).

### 5.3 Logs

Toda validacao tenta salvar log com:
- plataforma e versoes recebidas
- policy aplicada
- blocked true/false
- reason tecnico
- metadados de request (quando presentes)

Se o log falhar, a API continua respondendo (nao quebra o fluxo do app).

## 6. Cache e timeout

Implementado no repositorio:

- Cache de policy por plataforma (memoria local do processo)
  - Env: `APP_VERSION_POLICY_CACHE_TTL_MS`
  - Default: 5000 ms

- Timeout curto da query de policy
  - Env: `APP_VERSION_POLICY_QUERY_TIMEOUT_MS`
  - Default: 1500 ms

Objetivo:
- reduzir latencia em startup do app
- evitar travamento de request por query lenta

## 7. Como testar localmente antes de producao

## 7.1 Pre-requisitos

1. Banco MySQL local disponivel e `DATABASE_URL` configurada.
2. Dependencias instaladas.
3. Prisma client gerado apos alteracoes de schema.

Comandos:

```bash
npm install
npx prisma generate
```

## 7.2 Aplicar migration local

Se seu ambiente local usa fluxo de migrations pendentes:

```bash
npx prisma migrate deploy
```

Se seu time usa outro fluxo local, siga o padrao interno equivalente.

## 7.3 Subir API local

```bash
npm run start:dev
```

## 7.4 Teste rapido do endpoint (sem bloqueio)

```bash
curl -X POST http://localhost:3001/api/app-version/validate \
  -H "Content-Type: application/json" \
  -d '{"platform":"android","appVersion":"1.1.7","runtimeVersion":"1.1.7","versionCode":42}'
```

Esperado:
- `forceUpdate: false`

## 7.5 Ativar bloqueio Android e testar

Exemplo SQL:

```sql
UPDATE AppVersionPolicy
SET
  minSupportedVersion = '1.1.8',
  minSupportedRuntimeVersion = '1.1.8',
  minSupportedVersionCode = 43,
  forceUpdateEnabled = true,
  updatedAt = CURRENT_TIMESTAMP(3),
  notes = 'Ativacao update obrigatorio Android'
WHERE platform = 'android'
  AND isActive = true;
```

Repetir request com versao menor:

```bash
curl -X POST http://localhost:3001/api/app-version/validate \
  -H "Content-Type: application/json" \
  -d '{"platform":"android","appVersion":"1.1.7","runtimeVersion":"1.1.7","versionCode":42}'
```

Esperado:
- `forceUpdate: true`
- retorno com `title`, `message` e `storeUrl`

## 7.6 Teste iOS por buildNumber

Exemplo SQL:

```sql
UPDATE AppVersionPolicy
SET
  minSupportedBuildNumber = 8,
  forceUpdateEnabled = true,
  updatedAt = CURRENT_TIMESTAMP(3),
  notes = 'Ativacao update obrigatorio iOS'
WHERE platform = 'ios'
  AND isActive = true;
```

Request iOS abaixo do minimo:

```bash
curl -X POST http://localhost:3001/api/app-version/validate \
  -H "Content-Type: application/json" \
  -d '{"platform":"ios","appVersion":"1.1.8","runtimeVersion":"1.1.8","buildNumber":"7"}'
```

Esperado:
- `forceUpdate: true`

## 7.7 Verificar auditoria

```sql
SELECT
  id,
  platform,
  appVersion,
  runtimeVersion,
  versionCode,
  buildNumber,
  blocked,
  reason,
  createdAt
FROM AppVersionValidationLog
ORDER BY createdAt DESC
LIMIT 50;
```

## 7.8 Rodar testes automatizados novos

```bash
npm test -- app-version.service.spec.ts app-version.controller.integration.spec.ts
```

## 8. Cuidados antes de subir para producao

1. Nao ativar `forceUpdateEnabled` imediatamente em producao.
2. Primeiro publicar backend com policy em modo observacao (`forceUpdateEnabled = false`).
3. Depois que app novo estiver distribuido, ativar bloqueio gradualmente.
4. Confirmar `storeUrl` correta para cada plataforma (Play Store/App Store).
5. Garantir que minimos (appVersion/runtimeVersion/versionCode/buildNumber) estao coerentes com release real.
6. Monitorar taxa de bloqueio por plataforma apos ativacao.
7. Ter SQL de rollback pronto para desativar bloqueio rapido.

Exemplo rollback rapido:

```sql
UPDATE AppVersionPolicy
SET
  forceUpdateEnabled = false,
  updatedAt = CURRENT_TIMESTAMP(3),
  notes = 'Rollback emergencial de bloqueio'
WHERE platform IN ('android', 'ios')
  AND isActive = true;
```

## 9. Riscos e mitigacoes

- Risco: bloqueio global acidental.
  - Mitigacao: rollout por fases e por plataforma.

- Risco: valores de versao mal configurados na policy.
  - Mitigacao: validar em staging/homologacao com payloads reais antes da ativacao.

- Risco: link de loja invalido.
  - Mitigacao: checklist obrigatorio de storeUrl por plataforma.

- Risco: endpoint indisponivel ou lento.
  - Mitigacao: cache + timeout curto + monitoramento.

## 10. Checklist de pronto

- Migration aplicada no ambiente alvo.
- Endpoint respondendo em /api/app-version/validate.
- Politicas Android/iOS cadastradas com `forceUpdateEnabled = false` inicialmente.
- Testes automatizados do modulo passando.
- Testes manuais Android e iOS validados.
- SQL de rollback pronto e testado.
