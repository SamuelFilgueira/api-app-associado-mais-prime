import { Module } from '@nestjs/common';
import {
  EXPO_UPDATES_CONFIG,
  carregarExpoUpdatesConfig,
} from 'src/expo-updates/config/expo-updates.config';
import { ExpoUpdatesAdminController } from 'src/expo-updates/controllers/expo-updates-admin.controller';
import { ExpoUpdatesController } from 'src/expo-updates/controllers/expo-updates.controller';
import { ExpoUpdatesManifestService } from 'src/expo-updates/services/expo-updates-manifest.service';
import { ExpoUpdatesReleasesService } from 'src/expo-updates/services/expo-updates-releases.service';

/**
 * Servidor de atualizações OTA (self-hosted Expo Updates).
 * Docs: docs/EXPO_UPDATES_OTA.md
 */
@Module({
  controllers: [ExpoUpdatesController, ExpoUpdatesAdminController],
  providers: [
    { provide: EXPO_UPDATES_CONFIG, useFactory: carregarExpoUpdatesConfig },
    ExpoUpdatesReleasesService,
    ExpoUpdatesManifestService,
  ],
})
export class ExpoUpdatesModule {}
