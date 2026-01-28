# 📚 Documentação do Sistema de Notificações

Bem-vindo à documentação completa do sistema de notificações como fonte de verdade!

---

## 📖 Índice de Documentos

### 1. [NOTIFICATIONS_SUMMARY.md](./NOTIFICATIONS_SUMMARY.md)
**Resumo Executivo da Implementação**

Visão geral de tudo que foi implementado:
- ✅ Modelo de banco de dados
- ✅ DTOs criados
- ✅ Service expandido (8 métodos)
- ✅ Controller atualizado (5 endpoints)
- ✅ Segurança e validações
- ✅ Checklist completo

📌 **Recomendado para:** Gerentes de projeto, tech leads, overview rápido

---

### 2. [NOTIFICATIONS_API.md](./NOTIFICATIONS_API.md)
**Documentação Completa da API**

Referência detalhada de todos os endpoints:
- 🔐 Autenticação (JWT)
- 📚 Endpoints disponíveis (GET, PATCH, DELETE)
- 📊 Estrutura do banco de dados
- 🔄 Fluxo de sincronização no app mobile
- 💡 Exemplos com cURL
- 🔍 Logs do sistema

📌 **Recomendado para:** Desenvolvedores backend, QA, documentação de API

---

### 3. [NOTIFICATIONS_INTEGRATION.md](./NOTIFICATIONS_INTEGRATION.md)
**Guia de Integração com Outros Módulos**

Como usar o sistema de notificações no seu código:
- 🔧 Integração no módulo de rastreamento
- 🎯 Exemplo completo com webhook M7
- 📱 Integração no frontend (React Native)
- 🔄 Suporte a múltiplos dispositivos
- 🧹 Limpeza automática (cron job)
- 📊 Hook customizado `useNotifications()`

📌 **Recomendado para:** Desenvolvedores backend e frontend, arquitetos

---

### 4. [NOTIFICATIONS_MIGRATION.md](./NOTIFICATIONS_MIGRATION.md)
**Guia de Migração de Código Existente**

Como atualizar código que já usa `sendPushNotification()`:
- ⚠️ Breaking changes
- 🔄 Exemplos de migração
- 🔍 Como encontrar código que precisa atualização
- 🚨 Erros comuns e soluções
- ✅ Validação pós-migração

📌 **Recomendado para:** Desenvolvedores que já têm código usando o sistema antigo

---

## 🚀 Quick Start

### Para Testar a API:

1. **Enviar uma notificação de teste:**
```bash
curl -X POST http://localhost:3000/notifications/test \
  -H "Content-Type: application/json" \
  -d '{
    "expoPushToken": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
    "plate": "ABC-1234",
    "ignition": "on",
    "title": "Teste",
    "body": "Notificação de teste",
    "ignitionOn": true,
    "ignitionOff": false
  }'
```

2. **Buscar notificações não lidas:**
```bash
curl -X GET http://localhost:3000/notifications/user/1/unread \
  -H "Authorization: Bearer SEU_TOKEN_JWT"
```

3. **Marcar como lida:**
```bash
curl -X PATCH http://localhost:3000/notifications/123/read \
  -H "Authorization: Bearer SEU_TOKEN_JWT"
```

---

### Para Integrar no Seu Código:

```typescript
// 1. Importar o módulo
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  // ...
})
export class SeuModule {}

// 2. Injetar o service
constructor(
  private readonly notificationsService: NotificationsService,
) {}

// 3. Usar
await this.notificationsService.sendPushNotification(
  userId,           // ID do usuário
  expoPushToken,    // Token Expo
  'Título',         // Título da notificação
  'Corpo',          // Corpo da notificação
  { plate, ignition }, // Dados customizados
  { ignitionOn: true, ignitionOff: true }, // Preferências
);
```

---

## 📁 Estrutura de Arquivos

```
src/notifications/
├── DTOs/
│   ├── create-notification.dto.ts
│   ├── get-notifications-response.dto.ts
│   ├── send-notification.dto.ts
│   └── test-notification.dto.ts
├── notifications.controller.ts    (5 endpoints)
├── notifications.service.ts       (8 métodos)
└── notifications.module.ts

prisma/
├── schema.prisma                  (Model Notification)
└── migrations/
    └── 20260119123248_add_notification_model/
        └── migration.sql

docs/
├── NOTIFICATIONS_SUMMARY.md       (Resumo executivo)
├── NOTIFICATIONS_API.md           (Documentação da API)
├── NOTIFICATIONS_INTEGRATION.md   (Guia de integração)
└── NOTIFICATIONS_MIGRATION.md     (Guia de migração)
```

---

## 🎯 Fluxo Completo

```
┌───────────────────────────────────────────────────────────────┐
│  1. Evento (Webhook, User Action, Cron)                      │
└────────────────────────┬──────────────────────────────────────┘
                         │
                         ▼
┌───────────────────────────────────────────────────────────────┐
│  2. Backend: sendPushNotification(userId, token, ...)        │
│     → Salva no banco (Notification table)                     │
│     → Envia via Expo Push Service                             │
└────────────────────────┬──────────────────────────────────────┘
                         │
                         ▼
┌───────────────────────────────────────────────────────────────┐
│  3. App Mobile: Recebe notificação                           │
│     → Foreground: exibe imediatamente                         │
│     → Background: exibe na bandeja do sistema                 │
└────────────────────────┬──────────────────────────────────────┘
                         │
                         ▼
┌───────────────────────────────────────────────────────────────┐
│  4. App Mobile: Sincroniza ao abrir                          │
│     → GET /notifications/user/:userId/unread                  │
│     → Recupera notificações perdidas em background            │
└────────────────────────┬──────────────────────────────────────┘
                         │
                         ▼
┌───────────────────────────────────────────────────────────────┐
│  5. Usuário Interage                                          │
│     → Clica: PATCH /:id/read                                  │
│     → Deleta: DELETE /:id                                     │
│     → Marca tudo: PATCH /user/:userId/read-all                │
└───────────────────────────────────────────────────────────────┘
```

---

## 🔐 Segurança

✅ **JWT Authentication**: Todos os endpoints (exceto `/test`)  
✅ **Authorization**: Validação de ownership (userId)  
✅ **Input Validation**: class-validator em todos os DTOs  
✅ **Error Handling**: NotFoundException, ForbiddenException  
✅ **SQL Injection Protection**: Prisma ORM  

---

## 📊 Database Schema

```prisma
model Notification {
  id              Int       @id @default(autoincrement())
  userId          Int
  expoPushToken   String    @db.VarChar(255)
  title           String    @db.VarChar(255)
  body            String    @db.Text
  data            Json      // { plate, ignition, ... }
  read            Boolean   @default(false)
  sentAt          DateTime  @default(now())
  readAt          DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  
  user            user      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, read])
  @@index([sentAt])
  @@index([createdAt])
}
```

---

## 🌟 Features

✅ **Persistência Completa**: Todas as notificações salvas no MySQL  
✅ **Sincronização**: App recupera histórico em background  
✅ **Estado de Leitura**: Tracking de notificações lidas/não lidas  
✅ **Paginação**: Suporte a limit/offset  
✅ **Limpeza Automática**: Método para remover notificações antigas  
✅ **Logs Estruturados**: Monitoramento completo  
✅ **Performance**: Índices otimizados  
✅ **Segurança**: JWT + ownership validation  

---

## 🧪 Testes

### Endpoints Principais:
- `GET /notifications/user/:userId/unread` - Notificações não lidas
- `GET /notifications/user/:userId` - Todas as notificações
- `PATCH /notifications/:id/read` - Marcar como lida
- `PATCH /notifications/user/:userId/read-all` - Marcar todas como lidas
- `DELETE /notifications/:id` - Deletar notificação
- `POST /notifications/test` - Teste (sem auth)

---

## 📝 Próximos Passos

### Backend:
- [ ] Testes unitários (Jest)
- [ ] Testes e2e
- [ ] Documentação Swagger
- [ ] Cron job para limpeza automática
- [ ] Tabela `UserDevice` para múltiplos dispositivos
- [ ] Rate limiting

### Frontend:
- [ ] Hook `useNotifications()`
- [ ] Sincronização automática
- [ ] Badge de contador
- [ ] Tela de histórico
- [ ] Pull-to-refresh
- [ ] Paginação infinita

---

## 🆘 Suporte

Para dúvidas ou problemas:

1. Consulte a documentação apropriada acima
2. Verifique os logs do backend (`Logger`)
3. Teste com o endpoint `/test` primeiro
4. Revise o código de exemplo em `NOTIFICATIONS_INTEGRATION.md`

---

## 📚 Recursos Adicionais

- [Prisma Docs](https://www.prisma.io/docs)
- [NestJS Docs](https://docs.nestjs.com)
- [Expo Push Notifications](https://docs.expo.dev/push-notifications/overview/)
- [JWT Authentication](https://docs.nestjs.com/security/authentication)

---

**Desenvolvido com ❤️ para o projeto Benefícios API**

Última atualização: 19/01/2026
