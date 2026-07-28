# CONTEXTO

Após análise arquitetural completa do meu backend NestJS, decidi que NÃO quero separar os módulos em microservices agora.

Quero manter a aplicação como um monólito, porém transformar o sistema em um:

* Modular Monolith
* bem organizado
* desacoplado
* sustentável
* preparado para crescimento
* preparado para futura extração de serviços SE necessário.

A stack atual:

* NestJS 11
* Prisma
* MySQL
* BullMQ + Redis
* Docker
* TypeScript
* React Native consumindo a API

# OBJETIVO

Preciso que você gere um plano técnico e pragmático para EVOLUIR o monólito atual sem criar novos serviços.

NÃO quero:

* microservices agora;
* kubernetes;
* service mesh;
* overengineering;
* event-driven complexo;
* DDD extremo;
* clean architecture exagerada.

Quero foco em:

* organização;
* desacoplamento;
* padronização;
* manutenção;
* performance;
* clareza arquitetural;
* escalabilidade moderada;
* facilidade de deploy;
* facilidade de onboarding.

# QUERO QUE VOCÊ ME AJUDE A:

1. Transformar o projeto em um Modular Monolith bem estruturado.
2. Definir fronteiras claras entre módulos.
3. Eliminar acoplamentos incorretos.
4. Centralizar infraestrutura compartilhada.
5. Melhorar a arquitetura NestJS atual.
6. Padronizar módulos.
7. Melhorar autenticação.
8. Melhorar observabilidade.
9. Melhorar organização de pastas.
10. Melhorar resiliência sem separar serviços.

# BASEADO NA ANÁLISE EXISTENTE

Considere os problemas já identificados:

* PrismaService sendo reinstanciado em vários módulos;
* SgaService sem módulo próprio;
* providers duplicados;
* controllers registrados diretamente no AppModule;
* guards acoplados ao AdminPanelModule;
* múltiplos módulos importando classes diretamente;
* falta de versionamento de API;
* env validation incompleta;
* upload local sem abstração;
* autenticação admin e mobile compartilhando JWT_SECRET;
* ausência de boundaries claras;
* dependências transversais;
* AppModule gigante;
* módulos sem encapsulamento correto.

# O QUE ESPERO DA RESPOSTA

Quero um plano extremamente PRÁTICO e EXECUTÁVEL.

A resposta deve conter:

## 1. O QUE FAZER AGORA

Liste:

* mudanças prioritárias;
* quick wins;
* problemas críticos;
* melhorias de baixo risco;
* melhorias com maior impacto arquitetural.

Quero foco em:

* melhorias que aumentam qualidade sem aumentar complexidade operacional.

## 2. NOVA ORGANIZAÇÃO DO MONÓLITO

Quero:

* estrutura de pastas recomendada;
* organização ideal dos módulos NestJS;
* organização de infraestrutura;
* organização de integrações externas;
* organização de guards/interceptors;
* organização de filas;
* organização de configs;
* organização de providers compartilhados.

Mostre uma árvore completa de pastas recomendada.

## 3. REGRAS ARQUITETURAIS

Defina regras claras como:

* módulos não podem importar services diretamente;
* tudo deve passar por módulos exportados;
* infraestrutura compartilhada deve ser global;
* domínio não pode depender de domínio;
* como evitar acoplamento circular;
* como organizar DTOs;
* como organizar interfaces;
* como organizar adapters/integrations;
* como organizar filas BullMQ.

Quero regras simples e pragmáticas.

## 4. COMO MELHORAR O APPMODULE

Hoje o AppModule está gigante.

Quero:

* como reduzir responsabilidades;
* como dividir bootstrap;
* como organizar imports;
* como separar infraestrutura;
* como remover providers duplicados.

## 5. COMO MELHORAR A AUTENTICAÇÃO

Considere:

* auth mobile;
* auth admin;
* JWTs;
* guards;
* roles;
* multi-tenancy;
* segurança.

Quero uma abordagem segura mas simples.

## 6. COMO MELHORAR O PRISMA

Quero:

* arquitetura ideal do PrismaModule;
* organização do schema;
* organização de repositories/services;
* transações;
* logs;
* performance;
* evitar N+1;
* boas práticas de Prisma no NestJS.

## 7. COMO MELHORAR INTEGRAÇÕES EXTERNAS

Hoje existem várias integrações:

* Hinova;
* Softruck;
* M7;
* Alloyal;
* ClubGas;
* Expo;
* SMTP.

Quero:

* padrão ideal de clients;
* retry;
* timeout;
* cache;
* organização;
* abstração;
* tratamento de erro;
* observabilidade.

## 8. COMO MELHORAR FILAS E JOBS

Quero:

* arquitetura ideal do BullMQ;
* organização de queues;
* organização de processors;
* retry strategy;
* dead letter queue;
* observabilidade;
* idempotência.

## 9. COMO MELHORAR UPLOADS

Hoje uso filesystem local.

Quero:

* forma correta de abstrair storage;
* como deixar preparado para S3 futuramente;
* organização de uploads;
* estratégia para Docker;
* URLs públicas;
* versionamento de arquivos.

## 10. COMO MELHORAR OBSERVABILIDADE

Quero uma abordagem simples e pragmática:

* logging estruturado;
* request id;
* tracing básico;
* health checks;
* métricas;
* monitoramento;
* logs por módulo;
* logs de integração externa.

SEM soluções enterprise complexas.

## 11. ROADMAP PRAGMÁTICO

Monte um roadmap dividido em:

* curto prazo;
* médio prazo;
* longo prazo.

Classifique:

* impacto;
* risco;
* esforço;
* prioridade.

Quero foco em:

* evolução incremental;
* sem parar produção;
* sem reescrever o sistema.

# IMPORTANTE

Quero recomendações PRAGMÁTICAS.

Sempre priorize:

* simplicidade;
* produtividade;
* previsibilidade;
* facilidade de manutenção.

Evite recomendações que só fazem sentido em empresas gigantes.

O objetivo é:

* deixar o monólito extremamente saudável;
* aumentar a vida útil da arquitetura;
* reduzir acoplamento;
* preparar o sistema para crescer sem sofrimento.

# FORMATO DA RESPOSTA

* Markdown extremamente organizado;
* tabelas;
* exemplos práticos;
* árvore de pastas;
* exemplos NestJS;
* exemplos Prisma;
* exemplos de arquitetura;
* exemplos de modularização.

Seja extremamente técnico e crítico.
