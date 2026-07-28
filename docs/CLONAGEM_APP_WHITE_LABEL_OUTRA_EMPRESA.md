# Clonagem White Label do App para Outra Empresa

Este documento lista, em ordem prática, tudo o que precisa ser ajustado para clonar o app para outra empresa do grupo, usando outras contas de desenvolvedor Android e iOS.

Objetivo: criar um novo app (nova marca) sem quebrar integrações existentes, mantendo notificações push e sincronização funcionando ponta a ponta.

## 1. Definir estratégia de clonagem

1. Decidir se a nova empresa vai usar:
   - mesmo backend e mesmo banco, com segregação lógica por base/empresa; ou
   - backend e banco separados.
2. Definir o nome comercial do app, pacote, bundle id e domínio de API da nova empresa.
3. Definir ambientes mínimos:
   - desenvolvimento
   - homologação
   - produção

## 2. Criar identidade da nova marca

1. Preparar nome curto e nome completo do app.
2. Gerar novos assets:
   - ícone Android
   - ícone iOS
   - splash
   - cores e tema
3. Revisar textos da UI (nome da empresa, termos legais, suporte, política de privacidade).
4. Revisar links internos do app (site, atendimento, FAQ).

## 3. Criar IDs e apps nas lojas (nova conta Android/iOS)

1. Android (Google Play Console da nova empresa):
   - criar novo app
   - definir package name final (applicationId)
   - definir trilhas internas/fechadas/produção
2. iOS (Apple Developer da nova empresa):
   - criar novo App ID (bundle identifier)
   - habilitar capability de Push Notifications
   - criar app no App Store Connect
3. Garantir que package name Android e bundle id iOS sejam únicos e estáveis (não mudar após publicação).

## 4. Ajustar identificadores técnicos do app mobile

1. Trocar slug, owner e identificadores do projeto de build da nova marca.
2. Trocar applicationId Android.
3. Trocar bundleIdentifier iOS.
4. Revisar deep links, URL scheme e universal links/app links (se existirem).
5. Revisar nome de exibição (launcher/home screen) para cada plataforma.

## 5. Configurar assinatura e credenciais de publicação

1. Android:
   - gerar ou importar keystore da nova empresa
   - guardar alias, senhas e arquivo em cofre seguro
2. iOS:
   - criar certificados, profiles e team da nova empresa
   - garantir provisioning para bundle novo
3. CI/CD:
   - separar variáveis por app e ambiente
   - não reutilizar credenciais da empresa anterior

## 6. Configurar Push Notifications para a nova empresa

Esta etapa é obrigatória para funcionar em produção com as novas contas.

### 6.1 Como o push funciona hoje neste backend

1. O backend envia push via Expo Server SDK.
2. O token usado é Expo Push Token do dispositivo.
3. O backend registra token por usuário e salva histórico em banco.
4. O app sincroniza notificações não lidas via API ao abrir.

Referências já implementadas neste repositório:

- Envio via Expo + payload com channelId alerts_v2: [src/notifications/notifications.service.ts](src/notifications/notifications.service.ts)
- Registro de token no backend: [src/notifications/notifications.controller.ts](src/notifications/notifications.controller.ts)
- Endpoints de leitura/sincronização: [docs/NOTIFICATIONS_API.md](docs/NOTIFICATIONS_API.md)
- Prefixo global da API (/api): [src/main.ts](src/main.ts)

### 6.2 O que precisa ser trocado no mobile para push

1. Criar projeto Firebase da nova empresa (Android).
2. Cadastrar app Android no Firebase com o novo package name.
3. Baixar google-services.json da nova empresa e configurar no app mobile.
4. Cadastrar app iOS no Firebase com o novo bundle id (quando aplicável ao fluxo adotado).
5. No Apple Developer da nova empresa:
   - criar chave APNs Auth Key (.p8)
   - guardar Key ID e Team ID
   - garantir Push Notifications habilitado no App ID
6. Subir credenciais FCM/APNs no pipeline de build da nova marca.
7. No app, garantir que o código de push:
   - pede permissão
   - obtém Expo Push Token no projeto da nova marca
   - envia token autenticado para POST /api/notifications/register-token

### 6.3 Ponto crítico de compatibilidade (Android)

1. O backend envia notificações com channelId igual a alerts_v2.
2. O app Android da nova marca precisa criar esse mesmo canal localmente.
3. Se o canal não existir no app, a notificação pode chegar sem comportamento esperado (som/importância).

### 6.4 Ponto crítico de compatibilidade (iOS)

1. O backend envia payload com _contentAvailable e mutableContent.
2. O app iOS da nova marca deve manter configuração de push/background condizente com esse payload.
3. Garantir entitlement/capabilities corretas no projeto iOS da nova empresa.

## 7. Confirmar integração do app com o backend

1. Ajustar base URL de API no app para o ambiente correto da nova empresa.
2. Garantir envio do JWT em endpoints protegidos.
3. Garantir uso do prefixo /api nas chamadas.
4. Confirmar fluxo de notificações no app:
   - registrar token
   - buscar não lidas
   - marcar como lida
   - limpar/deletar

Endpoints de referência:

- POST /api/notifications/register-token
- GET /api/notifications/user/:userId/unread
- GET /api/notifications/user/:userId
- PATCH /api/notifications/:notificationId/read
- PATCH /api/notifications/user/:userId/read-all

Documentação: [docs/NOTIFICATIONS_API.md](docs/NOTIFICATIONS_API.md)

## 8. Validar se haverá segregação por base/empresa no backend

Se a nova empresa compartilhar o mesmo backend, validar obrigatoriamente:

1. Estratégia de baseOrigin do usuário no JWT e no banco.
2. Mapeamento de tokens/segredos por base no resolvedor atual.
3. Variáveis de ambiente da nova base para integrações externas (SGA, M7, Softruck, Alloyal, Clubgas, etc.).

Referências:

- Base em request/token: [src/shared/base-context.service.ts](src/shared/base-context.service.ts)
- Mapa de chaves por base: [src/shared/token-resolver.service.ts](src/shared/token-resolver.service.ts)
- Enum baseOrigin na tabela user: [prisma/schema.prisma](prisma/schema.prisma)

Se a nova empresa tiver backend separado, replicar as variáveis e integrações no novo ambiente.

## 9. Revisar variáveis de ambiente por ambiente

1. Preencher variáveis obrigatórias e recomendadas.
2. Definir secrets diferentes por empresa e por ambiente.
3. Não reutilizar credenciais de produção da empresa original.

Referências:

- Exemplo base: [.env.example](.env.example)
- Validação de variáveis no boot: [src/config/env.validator.ts](src/config/env.validator.ts)

## 10. Ajustes de analytics para nova marca

1. Definir ANALYTICS_SECRET exclusivo da nova empresa.
2. Garantir que appVersion/runtimeVersion enviados no app reflitam o app clonado.
3. Confirmar que eventos seguem allowlist e não enviam dados proibidos.

Referência: [docs/ANALYTICS_IMPLEMENTATION.md](docs/ANALYTICS_IMPLEMENTATION.md)

## 11. Teste ponta a ponta de notificações (obrigatório antes de publicar)

1. Instalar build da nova marca em Android e iOS físicos.
2. Fazer login no app.
3. Confirmar registro de token via POST /api/notifications/register-token.
4. Disparar notificação de teste no backend:
   - POST /api/notifications/test (ambiente de teste)
   - ou fluxo real (webhook/fila) quando aplicável
5. Validar recebimento:
   - app em foreground
   - app em background
   - app fechado
6. Abrir app e validar sincronização de histórico:
   - GET /api/notifications/user/:userId/unread
7. Marcar como lida e validar estado no backend.
8. Repetir testes para Android e iOS.

## 12. Publicação e operação

1. Gerar build release Android e iOS da nova marca.
2. Subir para trilha interna/closed testing.
3. Validar crash-free, login, rastreamento, notificações, documentos e analytics.
4. Publicar gradualmente.
5. Monitorar logs de push, erros de API e métricas pós-release por 7 dias.

## 13. Checklist final de Go-Live

- Nome, ícones e textos da nova empresa aplicados
- IDs Android/iOS novos e estáveis
- Contas de loja e assinatura da nova empresa configuradas
- Push Android/iOS com credenciais da nova empresa funcionando
- Registro de Expo Push Token funcionando no backend
- Canal Android alerts_v2 criado no app
- Endpoints de sincronização de notificações validados
- Variáveis de ambiente separadas por empresa/ambiente
- Analytics com ANALYTICS_SECRET novo
- Testes reais em Android e iOS concluídos

## 14. Riscos comuns ao clonar white label

1. Reaproveitar bundle/package e bloquear publicação nas lojas.
2. Esquecer de trocar credenciais APNs/FCM e push parar em produção.
3. Não registrar expoPushToken no login e o usuário nunca receber push.
4. Não criar canal alerts_v2 no Android e ter comportamento inconsistente de notificação.
5. Misturar variáveis e segredos entre empresas e ambientes.
6. Publicar sem teste em device físico com app fechado.

## 15. Ordem recomendada de execução

1. Branding e IDs
2. Contas e credenciais Android/iOS
3. Configuração de push (FCM/APNs/Expo)
4. Ajuste de ambientes e API base URL
5. Testes E2E de notificação
6. Publicação gradual
