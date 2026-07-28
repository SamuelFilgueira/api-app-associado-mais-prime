# Plano de Execução Incremental — Refatoração Arquitetural

## Objetivo

Refatorar gradualmente a aplicação atual para uma arquitetura de Modular Monolith, mantendo compatibilidade total com o ambiente atual.

A aplicação DEVE continuar funcionando durante todas as etapas da migração.

O deploy continuará sendo realizado via:

```bash
git pull
docker compose up -d --build api
```

Sem necessidade de parar a VPS por longos períodos.

---

# Restrições Obrigatórias

## Compatibilidade

A IA NÃO deve:

* remover funcionalidades existentes
* alterar comportamento das rotas atuais
* alterar contratos HTTP
* alterar DTOs públicos
* alterar respostas da API
* alterar autenticação atual inicialmente
* alterar URLs existentes
* alterar estrutura atual de uploads
* alterar docker-compose atual
* introduzir dependências externas obrigatórias
* introduzir Redis novo
* introduzir S3
* remover providers antigos antes da migração completa
* mover arquivos em massa
* realizar refactors agressivos
* alterar lógica de negócio

---

# Estratégia Obrigatória

Toda alteração deve seguir:

```text
CRIAR → VALIDAR → MIGRAR USO → REMOVER LEGADO
```

NUNCA:

```text
REMOVER → RECRIAR
```

---

# Estratégia de Deploy Seguro

Todas as mudanças devem:

* permitir rollback simples
* manter bootstrap compatível
* funcionar parcialmente migradas
* evitar alterações destrutivas
* evitar dependências temporárias quebradas
* evitar mudanças simultâneas em múltiplos domínios

---

# Regra Obrigatória de Execução

Executar UMA etapa por vez.

Após cada etapa:

1. garantir compilação
2. garantir bootstrap
3. garantir injeção de dependência funcionando
4. garantir docker build funcionando
5. garantir rotas atuais funcionando
6. NÃO prosseguir automaticamente para próxima etapa

---

# Ordem Obrigatória de Execução

## Etapa 1 — DatabaseModule Global

Objetivo:
Centralizar PrismaService sem quebrar módulos existentes.

---

## Arquivos a criar

```text
src/database/database.module.ts
```

---

## Regras

Criar DatabaseModule usando @Global().

Exportar PrismaService.

NÃO alterar PrismaService atual ainda.

NÃO remover PrismaService dos módulos existentes ainda.

NÃO mover arquivos existentes.

---

## Resultado esperado

Todos os módulos continuam funcionando exatamente igual.

PrismaService passa a poder ser consumido globalmente.

---

## Critérios de validação

A aplicação deve:

* compilar
* subir normalmente
* conectar no banco
* responder rotas existentes

---

# Etapa 2 — InfraModule

Objetivo:
Centralizar infraestrutura compartilhada.

---

## Arquivos a criar

```text
src/infra/infra.module.ts
```

```text
src/infra/interceptors/
```

```text
src/infra/filters/
```

```text
src/infra/guards/
```

---

## Regras

Criar InfraModule usando @Global().

Inicialmente apenas:

* exportar MailService existente
* preparar estrutura de interceptors
* preparar estrutura de guards

NÃO mover guards ainda.

NÃO alterar Auth atual.

NÃO alterar providers existentes ainda.

---

## Resultado esperado

Infraestrutura preparada sem impacto funcional.

---

# Etapa 3 — LoggingInterceptor Global

Objetivo:
Adicionar observabilidade sem alterar regras de negócio.

---

## Arquivos a criar

```text
src/infra/interceptors/logging.interceptor.ts
```

---

## Regras

Adicionar interceptor global no main.ts.

Logs devem incluir:

* requestId
* método
* rota
* status
* duração

NÃO alterar formato de resposta da API.

NÃO quebrar logs atuais.

NÃO remover console logs existentes.

---

## Resultado esperado

Logs estruturados coexistindo com logs antigos.

---

# Etapa 4 — HttpExceptionFilter

Objetivo:
Padronizar erros sem quebrar clientes existentes.

---

## Regras

Adicionar filtro global.

Formato deve ser COMPATÍVEL com respostas atuais.

Se existir risco de breaking change:

* manter comportamento antigo

NÃO alterar mensagens de erro existentes.

---

# Etapa 5 — SgaModule

Objetivo:
Encapsular SgaService corretamente.

---

## Arquivos a criar

```text
src/sga/sga.module.ts
```

---

## Regras

Criar módulo exportando SgaService.

Importar SgaModule nos consumidores.

NÃO remover provider antigo imediatamente.

NÃO alterar lógica do SgaService.

NÃO mover controllers ainda.

---

## Resultado esperado

SgaService funcionando via módulo sem quebrar consumidores atuais.

---

# Etapa 6 — EconomiaModule

Objetivo:
Remover acoplamento direto entre FuelSession e EconomiaService.

---

## Arquivos a criar

```text
src/economia/economia.module.ts
```

---

## Regras

Exportar EconomiaService.

FuelSessionModule deve importar EconomiaModule.

NÃO alterar lógica de negócio.

NÃO alterar processors.

---

# Etapa 7 — StorageModule

Objetivo:
Criar abstração futura sem alterar filesystem atual.

---

## Arquivos a criar

```text
src/storage/storage.module.ts
src/storage/storage.service.ts
src/storage/providers/local-storage.provider.ts
```

---

## Regras IMPORTANTES

Filesystem local continua sendo o provider padrão.

Uploads atuais DEVEM continuar funcionando.

Estrutura atual de arquivos NÃO deve mudar.

Paths atuais NÃO devem mudar.

URLs atuais NÃO devem mudar.

NÃO implementar S3 agora.

NÃO alterar docker-compose além do volume persistente.

---

## Resultado esperado

Aplicação continua utilizando filesystem local normalmente.

---

# Etapa 8 — Health Check

Objetivo:
Adicionar endpoint de monitoramento seguro.

---

## Arquivos a criar

```text
src/infra/health/health.controller.ts
```

---

## Regras

Criar endpoint:

```text
GET /health
```

NÃO adicionar prefixo global ainda.

NÃO alterar rotas existentes.

Healthcheck deve:

* validar banco
* retornar uptime
* retornar status

---

# Etapa 9 — AppModule Cleanup

Objetivo:
Organizar AppModule gradualmente.

---

## Regras IMPORTANTES

NÃO fazer limpeza agressiva.

Remover providers SOMENTE se:

* já estiverem funcionando via módulos globais
* já estiverem validados
* já estiverem sendo utilizados via DI corretamente

Controllers inline só devem ser removidos após criação dos módulos equivalentes.

---

# Etapa 10 — Prisma Cleanup

Objetivo:
Eliminar providers redundantes com segurança.

---

## Regras IMPORTANTES

Somente remover PrismaService dos módulos após:

* DatabaseModule validado
* aplicação compilando
* bootstrap funcionando
* DI funcionando

Executar remoção GRADUALMENTE.

Nunca remover de todos os módulos de uma vez.

---

# Etapa 11 — Auth Improvements

Objetivo:
Melhorar autenticação sem breaking change.

---

## Regras IMPORTANTES

NÃO alterar JWT_SECRET atual inicialmente.

NÃO invalidar tokens existentes.

NÃO alterar expiração atual inicialmente.

Primeiro:

* adicionar audience
* adicionar validação compatível
* permitir tokens antigos temporariamente

Somente depois:

* endurecer validações

---

# Etapa 12 — Env Validation

Objetivo:
Evitar falhas silenciosas.

---

## Regras

Expandir validação das variáveis de ambiente.

NÃO tornar variáveis antigas obrigatórias sem fallback.

Sempre usar defaults compatíveis.

A aplicação deve continuar subindo mesmo parcialmente configurada.

---

# Regras Obrigatórias de Código

## NestJS

Seguir DI corretamente.

Evitar instanciar classes manualmente.

Usar módulos/export/providers corretamente.

---

## Prisma

Nunca instanciar PrismaClient manualmente fora do PrismaService.

---

## Imports

Manter padrão atual do projeto.

NÃO misturar padrões novos agressivamente.

---

## Refactors

Evitar:

* renomeações massivas
* movimentação massiva de arquivos
* alteração estrutural agressiva
* alteração de domínio junto com infraestrutura

---

# Regras Obrigatórias para o Copilot

## O Copilot DEVE

* priorizar compatibilidade
* priorizar segurança
* priorizar incrementalismo
* evitar breaking changes
* evitar mudanças destrutivas
* manter coexistência temporária entre legado e novo

---

## O Copilot NÃO DEVE

* apagar código legado automaticamente
* alterar contratos externos
* alterar rotas
* alterar DTOs públicos
* alterar responses
* alterar autenticação sem compatibilidade
* alterar estrutura de uploads
* alterar lógica de negócio
* realizar refactor global
* mover múltiplos módulos simultaneamente

---

# Regra de Segurança Máxima

Se houver dúvida entre:

* arquitetura ideal
  ou
* compatibilidade com produção

SEMPRE priorizar compatibilidade com produção.

---

# Estratégia Recomendada de Commits

Cada etapa deve gerar um commit isolado.

Exemplo:

```text
feat: add global database module
feat: add infra module
feat: add logging interceptor
feat: add storage abstraction
refactor: migrate sga service to sga module
```

---

# Critério Obrigatório de Finalização de Cada Etapa

Antes de finalizar qualquer etapa:

* aplicação deve compilar
* docker build deve funcionar
* bootstrap deve funcionar
* rotas atuais devem responder
* uploads atuais devem funcionar
* autenticação atual deve funcionar
* filas atuais devem funcionar

Se qualquer item falhar:

* interromper execução
* corrigir antes de prosseguir

---

# Observação Final

O objetivo NÃO é reescrever a aplicação.

O objetivo é:

* estabilizar arquitetura
* reduzir acoplamento
* melhorar observabilidade
* melhorar manutenção
* preparar evolução futura

SEM interromper produção.
