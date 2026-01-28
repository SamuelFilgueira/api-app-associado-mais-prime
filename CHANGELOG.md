# 📋 CHANGELOG - Sistema de Notificações

## [1.0.0] - 2026-01-19

### ✨ Added

#### Database
- **Modelo Prisma `Notification`** com os seguintes campos:
  - `id` (PK, auto-increment)
  - `userId` (FK para `user`, cascade delete)
  - `expoPushToken` (string, 255 chars)
  - `title` (string, 255 chars)
  - `body` (text)
  - `data` (JSON - flexível para diferentes tipos de notificações)
  - `read` (boolean, default false)
  - `sentAt` (datetime)
  - `readAt` (datetime, nullable)
  - `createdAt` (datetime)
  - `updatedAt` (datetime)
- **Índices otimizados**:
  - `(userId, read)` - Para queries de notificações não lidas
  - `sentAt` - Para ordenação cronológica
  - `createdAt` - Para limpeza de dados antigos
- **Relação** com model `user` (onDelete: Cascade)
- **Migration** aplicada: `20260119123248_add_notification_model`

#### DTOs
- `CreateNotificationDto` - Para criar notificações
  - Validações: @IsNumber, @IsString, @IsNotEmpty, @IsObject
- `GetNotificationsResponseDto` - Response individual
  - Campos: id, title, body, data, read, sentAt, readAt
- `GetNotificationsListResponseDto` - Response lista paginada
  - Campos: notifications[], total, unreadCount (opcional)

#### Service Methods (NotificationsService)
1. **saveNotification()**
   - Salva notificação no banco de dados
   - Log: `🔔 [DB] Notificação #X salva para user Y`

2. **sendPushNotification()** (MODIFICADO)
   - ✨ Novo parâmetro `userId` (primeiro na lista)
   - Salva no banco ANTES de enviar via Expo
   - Retorna `notificationId` junto com success/message
   - Logs: `🔔 [DB]` e `📤 [Expo]`

3. **getUnreadNotifications()**
   - Busca notificações não lidas com paginação
   - Parâmetros: userId, limit (default 50), offset (default 0)
   - Retorna: { notifications, total, unreadCount }
   - Log: `📬 [Query] X não lidas para user Y`

4. **getAllNotifications()**
   - Busca todas as notificações (lidas + não lidas) com paginação
   - Parâmetros: userId, limit, offset
   - Retorna: { notifications, total }
   - Log: `📋 [Query] X notificações para user Y`

5. **markAsRead()**
   - Marca uma notificação como lida
   - Validações: notificação existe + pertence ao usuário
   - Exceptions: NotFoundException, ForbiddenException
   - Log: `✅ [Update] Notificação #X marcada como lida`

6. **markAllAsRead()**
   - Marca todas as notificações não lidas como lidas
   - Retorna: { count: número de notificações atualizadas }
   - Log: `✅ [Update] X notificações marcadas como lidas para user Y`

7. **deleteNotification()**
   - Deleta uma notificação
   - Validações: notificação existe + pertence ao usuário
   - Exceptions: NotFoundException, ForbiddenException
   - Log: `🗑️ [Delete] Notificação #X deletada`

8. **cleanOldNotifications()**
   - Remove notificações antigas (>30 dias por padrão)
   - Parâmetro: daysOld (default 30)
   - Retorna: { deletedCount }
   - Log: `🧹 [Cleanup] X notificações antigas removidas (>Y dias)`

#### Controller Endpoints (NotificationsController)
1. **GET /notifications/user/:userId/unread**
   - Obtém notificações não lidas
   - Query params: limit, offset
   - Auth: ✅ JwtAuthGuard
   - Validação: userId do token = userId do param

2. **GET /notifications/user/:userId**
   - Obtém todas as notificações
   - Query params: limit, offset
   - Auth: ✅ JwtAuthGuard
   - Validação: userId do token = userId do param

3. **PATCH /notifications/:notificationId/read**
   - Marca uma notificação como lida
   - Auth: ✅ JwtAuthGuard
   - Validação: notificação pertence ao usuário

4. **PATCH /notifications/user/:userId/read-all**
   - Marca todas as notificações como lidas
   - Auth: ✅ JwtAuthGuard
   - Validação: userId do token = userId do param

5. **DELETE /notifications/:notificationId**
   - Deleta uma notificação
   - Auth: ✅ JwtAuthGuard
   - Validação: notificação pertence ao usuário
   - Response: { success: true, message: "..." }

6. **POST /notifications/test** (MODIFICADO)
   - Agora usa userId: 1 fixo internamente
   - Retorna notificationId junto com success/message
   - ⚠️ Sem autenticação (apenas para desenvolvimento)

#### Module Updates
- `NotificationsModule`
  - ✨ Adicionado `PrismaService` nos providers
  - Mantido export de `NotificationsService` para uso em outros módulos

#### Documentation
- **README.md** - Índice geral da documentação
- **NOTIFICATIONS_SUMMARY.md** - Resumo executivo da implementação
- **NOTIFICATIONS_API.md** - Documentação completa dos endpoints
- **NOTIFICATIONS_INTEGRATION.md** - Guia de integração com exemplos
- **NOTIFICATIONS_MIGRATION.md** - Guia de migração de código existente
- **CHANGELOG.md** - Este arquivo

### 🔄 Changed

#### Breaking Changes
- **sendPushNotification()** agora requer `userId` como primeiro parâmetro
  - Antes: `sendPushNotification(token, title, body, data, pref)`
  - Depois: `sendPushNotification(userId, token, title, body, data, pref)`
  - ⚠️ **AÇÃO REQUERIDA**: Atualizar todas as chamadas existentes
  - Consulte: `NOTIFICATIONS_MIGRATION.md`

#### Type Updates
- `NotificationData` agora permite campos adicionais: `[key: string]: any`
- Return type de `sendPushNotification()` expandido:
  - Antes: `{ success: boolean; message: string }`
  - Depois: `{ success: boolean; message: string; notificationId?: number }`

### 🔐 Security

- **JWT Guards** aplicados em todos os endpoints (exceto /test)
- **Ownership Validation** em todos os métodos que acessam/modificam notificações
- **Input Validation** com class-validator em todos os DTOs
- **Error Handling** padronizado (NotFoundException, ForbiddenException)
- **SQL Injection Protection** via Prisma ORM

### 📊 Performance

- **Índices de banco** otimizados para queries frequentes:
  - Notificações não lidas por usuário: O(log n)
  - Ordenação por data: O(log n)
  - Limpeza de dados antigos: O(log n)
- **Paginação** implementada em todos os endpoints de listagem
- **Cascade Delete** configurado (deletar usuário remove suas notificações)

### 📝 Logs & Monitoring

- Logs estruturados em todos os métodos do service:
  - `🔔 [DB]` - Operações de criação
  - `📤 [Expo]` - Envio via Expo
  - `📬 [Query]` - Buscas de notificações
  - `✅ [Update]` - Atualizações (marcar como lida)
  - `🗑️ [Delete]` - Deleções
  - `🧹 [Cleanup]` - Limpeza automática
  - `❌ [Expo]` - Erros ao enviar notificações

### 🧪 Testing

- ✅ Código TypeScript compila sem erros
- ✅ Migration aplicada com sucesso
- ✅ Endpoint /test funciona corretamente
- ⏳ Testes unitários (a implementar)
- ⏳ Testes e2e (a implementar)

### 📚 Dependencies

Nenhuma nova dependência adicionada. Sistema usa:
- `@prisma/client` (já existente)
- `expo-server-sdk` (já existente)
- `class-validator` (já existente)
- `class-transformer` (já existente)
- `@nestjs/common`, `@nestjs/jwt`, `@nestjs/passport` (já existentes)

### 🚀 Migration Path

Para usuários do sistema antigo:

1. ✅ Aplicar migration do Prisma
2. ⚠️ Atualizar chamadas a `sendPushNotification()` (adicionar userId)
3. ✅ Testar endpoints de sincronização
4. ✅ Atualizar app mobile para chamar novos endpoints
5. ⏳ (Opcional) Implementar cron job para limpeza automática

Consulte `NOTIFICATIONS_MIGRATION.md` para detalhes.

---

## 📋 Files Changed

### Created:
```
prisma/migrations/20260119123248_add_notification_model/migration.sql
src/notifications/DTOs/create-notification.dto.ts
src/notifications/DTOs/get-notifications-response.dto.ts
docs/README.md
docs/NOTIFICATIONS_SUMMARY.md
docs/NOTIFICATIONS_API.md
docs/NOTIFICATIONS_INTEGRATION.md
docs/NOTIFICATIONS_MIGRATION.md
docs/CHANGELOG.md
```

### Modified:
```
prisma/schema.prisma (+ Model Notification, + relation in user)
src/notifications/notifications.service.ts (+ 7 methods, modified 1)
src/notifications/notifications.controller.ts (+ 5 endpoints, modified 1)
src/notifications/notifications.module.ts (+ PrismaService provider)
```

### Unchanged:
```
src/notifications/DTOs/send-notification.dto.ts
src/notifications/DTOs/test-notification.dto.ts
```

---

## 🎯 Next Steps (Roadmap)

### v1.1.0 (Próxima Release)
- [ ] Implementar testes unitários (Jest)
- [ ] Implementar testes e2e
- [ ] Adicionar documentação Swagger (@ApiResponse decorators)
- [ ] Criar cron job para limpeza automática (@nestjs/schedule)
- [ ] Adicionar rate limiting nos endpoints de sincronização

### v1.2.0
- [ ] Criar model `UserDevice` para suportar múltiplos dispositivos
- [ ] Implementar soft delete (campo `deletedAt`)
- [ ] Adicionar campo `priority` para notificações urgentes
- [ ] Adicionar categorias de notificações (info, warning, error, etc.)

### v2.0.0
- [ ] Webhooks para notificações (callback quando lida/deletada)
- [ ] Suporte a rich notifications (imagens, ações)
- [ ] Analytics de engajamento (taxa de abertura, tempo de leitura)
- [ ] Notificações agendadas (send later)

---

## 🤝 Contributors

- Sistema implementado em 19/01/2026
- Desenvolvido para o projeto Benefícios API

---

## 📄 License

Proprietary - All rights reserved

---

**Para mais informações, consulte a documentação em `/docs`**
