# API de Notificações - Documentação

## 📋 Visão Geral

Sistema completo de notificações como fonte de verdade, permitindo que o app mobile sincronize o histórico completo mesmo quando estava em background.

---

## 🔐 Autenticação

Todos os endpoints (exceto `/test`) requerem autenticação via JWT.

**Header obrigatório:**
```
Authorization: Bearer <seu_token_jwt>
```

---

## 📚 Endpoints Disponíveis

### 1. Obter Notificações Não Lidas

**GET** `/notifications/user/:userId/unread`

Retorna apenas as notificações não lidas do usuário.

**Query Parameters:**
- `limit` (opcional, default: 50) - Número máximo de resultados
- `offset` (opcional, default: 0) - Número de registros a pular (paginação)

**Exemplo de Request:**
```bash
GET /notifications/user/1/unread?limit=20&offset=0
Authorization: Bearer eyJhbGc...
```

**Response (200 OK):**
```json
{
  "notifications": [
    {
      "id": 123,
      "title": "Ignição ligada",
      "body": "A ignição do veículo ABC-1234 foi ligada",
      "data": {
        "plate": "ABC-1234",
        "ignition": "on"
      },
      "read": false,
      "sentAt": "2026-01-19T12:30:00.000Z",
      "readAt": null
    }
  ],
  "total": 15,
  "unreadCount": 15
}
```

---

### 2. Obter Todas as Notificações

**GET** `/notifications/user/:userId`

Retorna todas as notificações do usuário (lidas + não lidas).

**Query Parameters:**
- `limit` (opcional, default: 50)
- `offset` (opcional, default: 0)

**Exemplo de Request:**
```bash
GET /notifications/user/1?limit=50&offset=0
Authorization: Bearer eyJhbGc...
```

**Response (200 OK):**
```json
{
  "notifications": [
    {
      "id": 124,
      "title": "Ignição desligada",
      "body": "A ignição do veículo ABC-1234 foi desligada",
      "data": {
        "plate": "ABC-1234",
        "ignition": "off"
      },
      "read": true,
      "sentAt": "2026-01-19T14:30:00.000Z",
      "readAt": "2026-01-19T15:00:00.000Z"
    },
    {
      "id": 123,
      "title": "Ignição ligada",
      "body": "A ignição do veículo ABC-1234 foi ligada",
      "data": {
        "plate": "ABC-1234",
        "ignition": "on"
      },
      "read": false,
      "sentAt": "2026-01-19T12:30:00.000Z",
      "readAt": null
    }
  ],
  "total": 100
}
```

---

### 3. Marcar como Lida

**PATCH** `/notifications/:notificationId/read`

Marca uma notificação específica como lida.

**Exemplo de Request:**
```bash
PATCH /notifications/123/read
Authorization: Bearer eyJhbGc...
```

**Response (200 OK):**
```json
{
  "id": 123,
  "userId": 1,
  "expoPushToken": "ExponentPushToken[xxxxx]",
  "title": "Ignição ligada",
  "body": "A ignição do veículo ABC-1234 foi ligada",
  "data": {
    "plate": "ABC-1234",
    "ignition": "on"
  },
  "read": true,
  "sentAt": "2026-01-19T12:30:00.000Z",
  "readAt": "2026-01-19T15:30:00.000Z",
  "createdAt": "2026-01-19T12:30:00.000Z",
  "updatedAt": "2026-01-19T15:30:00.000Z"
}
```

**Erros Possíveis:**
- `404 Not Found` - Notificação não encontrada
- `403 Forbidden` - Notificação não pertence ao usuário autenticado

---

### 4. Marcar Todas como Lidas

**PATCH** `/notifications/user/:userId/read-all`

Marca todas as notificações não lidas do usuário como lidas.

**Exemplo de Request:**
```bash
PATCH /notifications/user/1/read-all
Authorization: Bearer eyJhbGc...
```

**Response (200 OK):**
```json
{
  "count": 15
}
```

---

### 5. Deletar Notificação

**DELETE** `/notifications/:notificationId`

Deleta uma notificação específica.

**Exemplo de Request:**
```bash
DELETE /notifications/123
Authorization: Bearer eyJhbGc...
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Notificação deletada com sucesso"
}
```

**Erros Possíveis:**
- `404 Not Found` - Notificação não encontrada
- `403 Forbidden` - Notificação não pertence ao usuário autenticado

---

### 6. Testar Notificação (Apenas Desenvolvimento)

**POST** `/notifications/test`

Envia uma notificação de teste. Exige JWT com `role` ADMIN (`JwtAuthGuard` + `AdminRoleGuard`), assim como `POST /notifications/queue-test`.

**Request Body:**
```json
{
  "expoPushToken": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  "plate": "ABC-1234",
  "ignition": "on",
  "title": "Teste de Notificação",
  "body": "Esta é uma notificação de teste",
  "ignitionOn": true,
  "ignitionOff": false
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Notificação enviada com sucesso.",
  "notificationId": 125
}
```

---

## 🔄 Fluxo de Sincronização no App Mobile

### Ao Abrir o App:
```typescript
// 1. Buscar notificações não lidas
const response = await fetch('/notifications/user/1/unread', {
  headers: { Authorization: `Bearer ${token}` }
});

const { notifications, unreadCount } = await response.json();

// 2. Exibir badge com contador de não lidas
setBadgeCount(unreadCount);

// 3. Renderizar notificações na UI
setNotifications(notifications);
```

### Ao Clicar em uma Notificação:
```typescript
// Marcar como lida
await fetch(`/notifications/${notificationId}/read`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}` }
});

// Atualizar UI localmente
updateLocalNotification(notificationId, { read: true });
```

### Ao Deletar uma Notificação:
```typescript
await fetch(`/notifications/${notificationId}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${token}` }
});

// Remover da lista local
removeNotification(notificationId);
```

### Marcar Tudo como Lido:
```typescript
const response = await fetch(`/notifications/user/${userId}/read-all`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}` }
});

const { count } = await response.json();
console.log(`${count} notificações marcadas como lidas`);

// Atualizar UI
setBadgeCount(0);
```

---

## 📊 Estrutura do Banco de Dados

### Tabela: `Notification`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | Int | ID único (PK) |
| userId | Int | ID do usuário (FK) |
| expoPushToken | String | Token Expo que recebeu a notificação |
| title | String | Título da notificação |
| body | String | Corpo da notificação |
| data | Json | Dados estruturados ({ plate, ignition, ... }) |
| read | Boolean | Se foi lida (default: false) |
| sentAt | DateTime | Quando foi enviada |
| readAt | DateTime? | Quando foi lida (nullable) |
| createdAt | DateTime | Timestamp de criação |
| updatedAt | DateTime | Timestamp de atualização |

**Índices:**
- `(userId, read)` - Para queries de notificações não lidas
- `sentAt` - Para ordenação cronológica
- `createdAt` - Para limpeza de dados antigos

---

## 🔍 Logs do Sistema

O sistema gera logs estruturados para monitoramento:

```
🔔 [DB] Notificação #123 salva para user 1
📤 [Expo] Notificação #123 enviada com sucesso
📬 [Query] 15 não lidas para user 1
✅ [Update] Notificação #123 marcada como lida
🗑️ [Delete] Notificação #124 deletada
🧹 [Cleanup] 50 notificações antigas removidas (>30 dias)
```

---

## ⚙️ Limpeza Automática (Futuro)

O método `cleanOldNotifications()` pode ser chamado via Cron Job:

```typescript
// Em um serviço de cron (a ser implementado)
@Cron('0 0 * * *') // Diariamente à meia-noite
async handleCron() {
  await this.notificationsService.cleanOldNotifications(30);
}
```

---

## 🔒 Segurança

✅ **JWT Guard** - Todos os endpoints protegidos  
✅ **Validação de Ownership** - Usuário só vê suas notificações  
✅ **Validação de Input** - class-validator em todos os DTOs  
✅ **Error Handling** - Erros padronizados (404, 403, etc.)  

---

## 🚀 Próximos Passos

1. ✅ Backend implementado
2. ⏳ Atualizar app mobile para chamar novos endpoints
3. ⏳ Implementar sincronização automática ao abrir app
4. ⏳ Configurar cron job para limpeza de dados antigos
5. ⏳ Adicionar testes unitários e e2e
6. ⏳ Adicionar documentação Swagger (@ApiResponse decorators)

---

## 📝 Notas Importantes

- O endpoint `/test` usa `userId: 1` fixo. Em produção, remover ou proteger com autenticação.
- O campo `data` é flexível (tipo Json) para acomodar diferentes tipos de notificações futuras.
- Notificações são salvas no banco ANTES de serem enviadas via Expo, garantindo que nunca sejam perdidas.
- A relação com `user` está configurada com `onDelete: Cascade`, então deletar um usuário remove suas notificações.

---

## 💡 Exemplos de Uso com cURL

### Obter notificações não lidas
```bash
curl -X GET "http://localhost:3000/notifications/user/1/unread?limit=10" \
  -H "Authorization: Bearer seu_token_aqui"
```

### Marcar como lida
```bash
curl -X PATCH "http://localhost:3000/notifications/123/read" \
  -H "Authorization: Bearer seu_token_aqui"
```

### Deletar notificação
```bash
curl -X DELETE "http://localhost:3000/notifications/123" \
  -H "Authorization: Bearer seu_token_aqui"
```

### Marcar todas como lidas
```bash
curl -X PATCH "http://localhost:3000/notifications/user/1/read-all" \
  -H "Authorization: Bearer seu_token_aqui"
```

## Atualização (novembro de 2026)

- **Push unitário** (alertas, avisos): falha de transporte com o Expo faz o job repetir; recusa não. O
  aviso continua indo para a caixa de entrada do app mesmo quando o push é recusado.
- **Alerta de ignição e de âncora** é enfileirado (um job por usuário) em vez de enviado dentro do
  processamento do webhook, e respeita a preferência **por veículo** (`UserVehicle.notificacaoIgnicao`),
  com a preferência da conta valendo para o vínculo que ainda não tem valor próprio.
- **Disparos em massa**: ver `docs/NOTIFICACOES_AGENDAMENTO_E_LOG.md`.
