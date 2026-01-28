# Integração do Sistema de Notificações

## 📋 Como Usar o Sistema de Notificações em Outros Módulos

Este guia mostra como integrar o sistema de notificações em outros serviços do backend.

---

## 🔧 Exemplo: Enviando Notificações no Módulo de Rastreamento

### 1. Importar o NotificationsService

No módulo que deseja enviar notificações (ex: `rastreamento.module.ts`):

```typescript
import { Module } from '@nestjs/common';
import { RastreamentoService } from './rastreamento.service';
import { RastreamentoController } from './rastreamento.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule], // Importar módulo de notificações
  controllers: [RastreamentoController],
  providers: [RastreamentoService],
})
export class RastreamentoModule {}
```

---

### 2. Injetar no Service

No service (ex: `rastreamento.service.ts`):

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class RastreamentoService {
  private readonly logger = new Logger(RastreamentoService.name);

  constructor(
    private readonly notificationsService: NotificationsService,
  ) {}

  async handleIgnitionEvent(
    userId: number,
    expoPushToken: string,
    plate: string,
    ignition: 'on' | 'off',
  ) {
    // Lógica de rastreamento...
    
    // Buscar preferências do usuário do banco
    const userPreferences = await this.getUserPreferences(userId);

    // Verificar se o usuário quer receber notificação para este tipo de evento
    const shouldNotify = 
      (ignition === 'on' && userPreferences.ignitionOn) ||
      (ignition === 'off' && userPreferences.ignitionOff);

    if (!shouldNotify) {
      this.logger.log(`Notificação não enviada: usuário não tem preferência ativada`);
      return;
    }

    // Preparar dados da notificação
    const title = ignition === 'on' 
      ? '🔑 Ignição Ligada' 
      : '🔒 Ignição Desligada';
    
    const body = ignition === 'on'
      ? `A ignição do veículo ${plate} foi ligada`
      : `A ignição do veículo ${plate} foi desligada`;

    const data = {
      plate,
      ignition,
      timestamp: new Date().toISOString(),
    };

    const preference = {
      ignitionOn: userPreferences.ignitionOn,
      ignitionOff: userPreferences.ignitionOff,
    };

    // Enviar notificação (será salva automaticamente no banco)
    try {
      const result = await this.notificationsService.sendPushNotification(
        userId,
        expoPushToken,
        title,
        body,
        data,
        preference,
      );

      if (result.success) {
        this.logger.log(`✅ Notificação enviada: ID #${result.notificationId}`);
      } else {
        this.logger.warn(`⚠️ Falha ao enviar notificação: ${result.message}`);
      }
    } catch (error) {
      this.logger.error(`❌ Erro ao enviar notificação:`, error);
    }
  }

  private async getUserPreferences(userId: number) {
    // Implementar busca de preferências do usuário no banco
    // Por enquanto, retornando valores padrão
    return {
      ignitionOn: true,
      ignitionOff: true,
    };
  }
}
```

---

## 🎯 Exemplo Completo: Webhook M7

```typescript
// rastreamento.controller.ts
import { Controller, Post, Body, Logger } from '@nestjs/common';
import { RastreamentoService } from './rastreamento.service';

@Controller('rastreamento')
export class RastreamentoController {
  private readonly logger = new Logger(RastreamentoController.name);

  constructor(private readonly rastreamentoService: RastreamentoService) {}

  @Post('webhook/m7')
  async handleM7Webhook(@Body() payload: any) {
    this.logger.log('📥 Webhook M7 recebido');

    // Extrair dados do webhook
    const { plate, ignition, userId, expoPushToken } = payload;

    // Processar evento e enviar notificação se necessário
    await this.rastreamentoService.handleIgnitionEvent(
      userId,
      expoPushToken,
      plate,
      ignition,
    );

    return { success: true, message: 'Webhook processado' };
  }
}
```

---

## 📊 Fluxo Completo de Notificação

```
┌─────────────────────────────────────────────────────────────┐
│  1. Evento Externo (Webhook, Cron, User Action)            │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  2. Service chama NotificationsService.sendPushNotification │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Notificação é SALVA no banco (Notification table)       │
│     - userId, title, body, data, sentAt, read=false         │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  4. Notificação é ENVIADA via Expo Push Service             │
│     - App em foreground: recebe imediatamente                │
│     - App em background: recebe quando voltar                │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  5. App Mobile abre e SINCRONIZA via GET /unread            │
│     - Busca notificações perdidas quando estava em bg        │
│     - Exibe histórico completo                               │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  6. Usuário interage (clica, deleta, marca como lida)       │
│     - PATCH /read, DELETE /:id, etc.                         │
│     - Estado sincronizado entre app e servidor               │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔄 Múltiplos Dispositivos

O sistema suporta múltiplos dispositivos para o mesmo usuário:

```typescript
// Cenário: Usuário tem 2 celulares com o app instalado
// Ambos têm tokens Expo diferentes

async sendToAllUserDevices(
  userId: number,
  title: string,
  body: string,
  data: any,
) {
  // Buscar todos os tokens Expo do usuário (implementar tabela UserDevice)
  const devices = await this.getUserDevices(userId);

  const preference = await this.getUserPreferences(userId);

  // Enviar para cada dispositivo
  for (const device of devices) {
    await this.notificationsService.sendPushNotification(
      userId,
      device.expoPushToken,
      title,
      body,
      data,
      preference,
    );
  }
}
```

**Nota:** Isso criará múltiplas entradas no banco (uma por device), mas todas com o mesmo `userId`, permitindo que ambos os apps sincronizem o histórico.

---

## 🧹 Limpeza Automática de Notificações Antigas

### Criar um serviço de Cron (opcional)

```typescript
// notifications-cron.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationsCronService {
  private readonly logger = new Logger(NotificationsCronService.name);

  constructor(private readonly notificationsService: NotificationsService) {}

  // Executar diariamente à 3h da manhã
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleNotificationCleanup() {
    this.logger.log('🧹 Iniciando limpeza de notificações antigas...');
    
    const result = await this.notificationsService.cleanOldNotifications(30);
    
    this.logger.log(
      `✅ Limpeza concluída: ${result.deletedCount} notificações removidas`,
    );
  }
}
```

**Atualizar notifications.module.ts:**
```typescript
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsCronService } from './notifications-cron.service';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [NotificationsController],
  providers: [
    NotificationsService, 
    NotificationsCronService, 
    PrismaService
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
```

**Instalar dependência:**
```bash
npm install @nestjs/schedule
```

---

## 📱 Integração Frontend (React Native)

### Hook Customizado para Notificações

```typescript
// useNotifications.ts
import { useState, useEffect } from 'react';
import { useAuth } from './useAuth';

export function useNotifications() {
  const { user, token } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // Sincronizar notificações ao abrir o app
  const syncNotifications = async () => {
    if (!user || !token) return;

    setLoading(true);
    try {
      const response = await fetch(
        `${API_URL}/notifications/user/${user.id}/unread`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      const data = await response.json();
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch (error) {
      console.error('Erro ao sincronizar notificações:', error);
    } finally {
      setLoading(false);
    }
  };

  // Marcar como lida
  const markAsRead = async (notificationId: number) => {
    try {
      await fetch(
        `${API_URL}/notifications/${notificationId}/read`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      // Atualizar estado local
      setNotifications(prev =>
        prev.map(n =>
          n.id === notificationId
            ? { ...n, read: true, readAt: new Date() }
            : n
        )
      );
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Erro ao marcar como lida:', error);
    }
  };

  // Deletar notificação
  const deleteNotification = async (notificationId: number) => {
    try {
      await fetch(
        `${API_URL}/notifications/${notificationId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      // Remover do estado local
      setNotifications(prev =>
        prev.filter(n => n.id !== notificationId)
      );
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Erro ao deletar notificação:', error);
    }
  };

  // Marcar todas como lidas
  const markAllAsRead = async () => {
    if (!user) return;

    try {
      await fetch(
        `${API_URL}/notifications/user/${user.id}/read-all`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      // Atualizar estado local
      setNotifications(prev =>
        prev.map(n => ({ ...n, read: true, readAt: new Date() }))
      );
      setUnreadCount(0);
    } catch (error) {
      console.error('Erro ao marcar todas como lidas:', error);
    }
  };

  // Sincronizar ao montar o componente
  useEffect(() => {
    syncNotifications();
  }, [user, token]);

  return {
    notifications,
    unreadCount,
    loading,
    syncNotifications,
    markAsRead,
    deleteNotification,
    markAllAsRead,
  };
}
```

---

## ✅ Checklist de Implementação

- [x] Modelo Prisma criado
- [x] Migration aplicada
- [x] DTOs criados
- [x] Service expandido com 8 métodos
- [x] Controller com 5 novos endpoints
- [x] Guards JWT aplicados
- [x] Validações de ownership implementadas
- [x] Logs estruturados adicionados
- [x] Documentação criada
- [ ] Testes unitários (a implementar)
- [ ] Testes e2e (a implementar)
- [ ] Swagger/OpenAPI docs (a implementar)
- [ ] Cron job para limpeza (opcional)
- [ ] Frontend integrado (a implementar)

---

## 🎉 Benefícios do Sistema

✅ **Fonte Única de Verdade:** Banco de dados contém histórico completo  
✅ **Sincronização Automática:** App recupera notificações perdidas em background  
✅ **Estado Consistente:** Leitura/deleção sincronizadas entre dispositivos  
✅ **Escalável:** Suporta múltiplos dispositivos por usuário  
✅ **Auditável:** Timestamps completos (sentAt, readAt, createdAt, updatedAt)  
✅ **Performático:** Índices otimizados para queries rápidas  
✅ **Seguro:** Guards JWT e validação de ownership em todos os endpoints  

---

## 📞 Suporte

Em caso de dúvidas, consulte:
- [Documentação da API](./NOTIFICATIONS_API.md)
- [Schema Prisma](../prisma/schema.prisma)
- [Service Implementation](../src/notifications/notifications.service.ts)
