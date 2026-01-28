# 🔄 Guia de Migração - Atualizar Código Existente

## ⚠️ Breaking Changes

A assinatura do método `sendPushNotification()` foi alterada para incluir `userId` como primeiro parâmetro.

---

## 📝 O Que Precisa Ser Atualizado

Se você já estava usando `NotificationsService.sendPushNotification()` em outros lugares do código, precisa adicionar o parâmetro `userId`.

---

## 🔧 Exemplos de Migração

### ❌ ANTES (Código Antigo):

```typescript
// rastreamento.service.ts
await this.notificationsService.sendPushNotification(
  expoPushToken,
  title,
  body,
  data,
  preference,
);
```

### ✅ DEPOIS (Código Atualizado):

```typescript
// rastreamento.service.ts
await this.notificationsService.sendPushNotification(
  userId,           // ← NOVO parâmetro (primeiro)
  expoPushToken,
  title,
  body,
  data,
  preference,
);
```

---

## 🔍 Como Encontrar Código Que Precisa Ser Atualizado

Execute este comando no terminal para encontrar todas as chamadas ao método:

```bash
# Windows (PowerShell)
Get-ChildItem -Recurse -Filter *.ts | Select-String "sendPushNotification"

# Linux/Mac
grep -r "sendPushNotification" src/
```

---

## 📋 Checklist de Migração

- [ ] Buscar todas as chamadas a `sendPushNotification()`
- [ ] Adicionar `userId` como primeiro parâmetro em cada chamada
- [ ] Verificar se o `userId` está disponível no contexto
- [ ] Testar cada integração após atualização
- [ ] Verificar logs para confirmar que notificações estão sendo salvas

---

## 🎯 Exemplo Completo: Módulo de Rastreamento

### Antes:
```typescript
// rastreamento.service.ts
import { Injectable } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class RastreamentoService {
  constructor(
    private readonly notificationsService: NotificationsService,
  ) {}

  async handleIgnitionEvent(data: any) {
    const { plate, ignition, expoPushToken } = data;
    
    const title = ignition === 'on' ? 'Ignição Ligada' : 'Ignição Desligada';
    const body = `Veículo ${plate}`;
    
    const notificationData = { plate, ignition };
    const preference = { ignitionOn: true, ignitionOff: true };

    // ❌ FALTA userId
    await this.notificationsService.sendPushNotification(
      expoPushToken,
      title,
      body,
      notificationData,
      preference,
    );
  }
}
```

### Depois:
```typescript
// rastreamento.service.ts
import { Injectable } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma.service';

@Injectable()
export class RastreamentoService {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly prisma: PrismaService, // ← Para buscar userId
  ) {}

  async handleIgnitionEvent(data: any) {
    const { plate, ignition, expoPushToken } = data;
    
    // Buscar userId baseado na placa (ou outro identificador)
    const vehicle = await this.prisma.user.findFirst({
      where: { plate },
    });

    if (!vehicle) {
      console.error(`Usuário não encontrado para placa ${plate}`);
      return;
    }

    const title = ignition === 'on' ? 'Ignição Ligada' : 'Ignição Desligada';
    const body = `Veículo ${plate}`;
    
    const notificationData = { plate, ignition };
    const preference = { ignitionOn: true, ignitionOff: true };

    // ✅ COM userId
    const result = await this.notificationsService.sendPushNotification(
      vehicle.id,    // ← userId adicionado
      expoPushToken,
      title,
      body,
      notificationData,
      preference,
    );

    if (result.success) {
      console.log(`✅ Notificação #${result.notificationId} enviada`);
    }
  }
}
```

---

## 🔍 Locais Comuns Onde o Método É Usado

Verifique estes arquivos/módulos:

1. **Rastreamento** (`src/rastreamento/`)
   - Webhooks M7
   - Eventos de ignição
   - Alertas de movimento

2. **Auth** (`src/auth/`)
   - Notificações de login
   - Alertas de segurança

3. **Associado** (`src/associado/`)
   - Boas-vindas
   - Lembretes

4. **Controllers de Teste**
   - Endpoints de debug/teste

---

## 🧪 Como Testar Após Migração

### 1. Teste unitário do método atualizado:
```typescript
// rastreamento.service.spec.ts
it('should send notification with userId', async () => {
  const mockNotificationService = {
    sendPushNotification: jest.fn().mockResolvedValue({
      success: true,
      notificationId: 123,
    }),
  };

  // ... setup do teste

  await service.handleIgnitionEvent(mockData);

  expect(mockNotificationService.sendPushNotification).toHaveBeenCalledWith(
    1,                        // userId
    'ExponentPushToken[...]', // expoPushToken
    'Ignição Ligada',         // title
    expect.any(String),       // body
    expect.any(Object),       // data
    expect.any(Object),       // preference
  );
});
```

### 2. Teste manual via endpoint:
```bash
# 1. Enviar notificação
curl -X POST http://localhost:3000/notifications/test \
  -H "Content-Type: application/json" \
  -d '{"expoPushToken":"ExponentPushToken[xxx]","plate":"ABC-1234","ignition":"on","title":"Teste","body":"Teste","ignitionOn":true,"ignitionOff":false}'

# 2. Verificar se foi salva no banco
curl -X GET http://localhost:3000/notifications/user/1/unread \
  -H "Authorization: Bearer SEU_TOKEN"

# 3. Verificar logs do backend
# Deve aparecer: 🔔 [DB] Notificação #X salva para user 1
```

---

## ⚡ Dicas de Migração Rápida

### Se você tem acesso ao userId no contexto do webhook/evento:
```typescript
// ✅ Ideal: userId vem no payload
const { userId, expoPushToken, ... } = webhookPayload;

await this.notificationsService.sendPushNotification(
  userId,
  expoPushToken,
  ...
);
```

### Se precisa buscar o userId:
```typescript
// ✅ Buscar pelo identificador (plate, email, cpf, etc.)
const user = await this.prisma.user.findFirst({
  where: { plate: payload.plate },
});

if (!user) {
  throw new NotFoundException('Usuário não encontrado');
}

await this.notificationsService.sendPushNotification(
  user.id,
  expoPushToken,
  ...
);
```

### Se tem múltiplos usuários:
```typescript
// ✅ Enviar para múltiplos usuários
const users = await this.prisma.user.findMany({
  where: { someCondition: true },
});

for (const user of users) {
  await this.notificationsService.sendPushNotification(
    user.id,
    user.expoPushToken,
    ...
  );
}
```

---

## 🚨 Erros Comuns Durante Migração

### Erro 1: "Expected 6 arguments, but got 5"
**Causa:** Esqueceu de adicionar `userId` como primeiro parâmetro.

**Solução:**
```typescript
// ❌ Errado
sendPushNotification(token, title, body, data, pref)

// ✅ Correto
sendPushNotification(userId, token, title, body, data, pref)
```

### Erro 2: "Cannot read property 'id' of null"
**Causa:** Usuário não foi encontrado no banco.

**Solução:**
```typescript
const user = await this.prisma.user.findFirst({ where: { plate } });

if (!user) {
  this.logger.warn(`Usuário não encontrado para placa ${plate}`);
  return; // ← Não continuar se não encontrou
}

await this.notificationsService.sendPushNotification(user.id, ...);
```

### Erro 3: Notificação não aparece no histórico
**Causa:** `userId` está incorreto ou é `undefined`.

**Solução:**
```typescript
// Validar userId antes de enviar
if (!userId || typeof userId !== 'number') {
  throw new BadRequestException('userId inválido');
}

await this.notificationsService.sendPushNotification(userId, ...);
```

---

## ✅ Validação Pós-Migração

Após atualizar o código, verifique:

- [ ] Código compila sem erros TypeScript
- [ ] Testes unitários passam
- [ ] Notificações continuam sendo enviadas via Expo
- [ ] Notificações aparecem em `GET /notifications/user/:userId/unread`
- [ ] Logs mostram `🔔 [DB] Notificação #X salva para user Y`
- [ ] Não há erros de "userId is undefined"

---

## 📞 Suporte

Se encontrar problemas durante a migração:

1. Verifique os logs do backend para detalhes do erro
2. Confirme que o `userId` está disponível no contexto
3. Teste com o endpoint `/test` primeiro
4. Consulte a documentação completa em `NOTIFICATIONS_API.md`

---

**Boa migração! 🚀**
