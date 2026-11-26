import { Module } from '@nestjs/common';
import { ExpoPushClient } from 'src/integrations/expo/expo-push.client';
import { PushGateway } from 'src/integrations/expo/push.gateway';

/**
 * Integração Expo Push. Os módulos de domínio importam este módulo e injetam
 * a porta `PushGateway` — nunca o SDK do Expo.
 */
@Module({
  providers: [
    ExpoPushClient,
    { provide: PushGateway, useExisting: ExpoPushClient },
  ],
  exports: [PushGateway, ExpoPushClient],
})
export class ExpoModule {}
