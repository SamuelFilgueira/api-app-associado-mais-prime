CREATE TABLE `AppVersionPolicy` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `platform` VARCHAR(10) NOT NULL,
  `minSupportedVersion` VARCHAR(32) NOT NULL,
  `minSupportedRuntimeVersion` VARCHAR(32) NULL,
  `minSupportedVersionCode` INT NULL,
  `minSupportedBuildNumber` INT NULL,
  `forceUpdateEnabled` BOOLEAN NOT NULL DEFAULT false,
  `title` VARCHAR(120) NOT NULL DEFAULT 'Atualizacao obrigatoria',
  `message` VARCHAR(500) NOT NULL DEFAULT 'Uma nova versao do app esta disponivel. Atualize para continuar.',
  `storeUrl` VARCHAR(500) NULL,
  `effectiveFrom` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `effectiveUntil` DATETIME(3) NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdBy` VARCHAR(120) NULL,
  `notes` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `AppVersionPolicy_platform_active_idx`(`platform`, `isActive`, `effectiveFrom` DESC),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AppVersionValidationLog` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `requestId` CHAR(36) NULL,
  `platform` VARCHAR(10) NOT NULL,
  `appVersion` VARCHAR(32) NULL,
  `runtimeVersion` VARCHAR(32) NULL,
  `versionCode` INT NULL,
  `buildNumber` INT NULL,
  `policyId` INT NULL,
  `blocked` BOOLEAN NOT NULL,
  `reason` VARCHAR(120) NULL,
  `userId` INT NULL,
  `ipAddress` VARCHAR(45) NULL,
  `userAgent` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `AppVersionValidationLog_createdAt_idx`(`createdAt` DESC),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AppVersionValidationLog`
  ADD CONSTRAINT `AppVersionValidationLog_policyId_fkey`
  FOREIGN KEY (`policyId`) REFERENCES `AppVersionPolicy`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO `AppVersionPolicy` (
  `platform`,
  `minSupportedVersion`,
  `minSupportedRuntimeVersion`,
  `minSupportedVersionCode`,
  `forceUpdateEnabled`,
  `title`,
  `message`,
  `storeUrl`,
  `createdBy`,
  `notes`,
  `updatedAt`
) VALUES (
  'android',
  '1.1.7',
  '1.1.7',
  42,
  false,
  'Atualizacao obrigatoria',
  'Uma nova versao do app esta disponivel. Atualize para continuar.',
  'https://play.google.com/store/apps/details?id=com.maisprime.vantagens',
  'migration-seed',
  'Baseline inicial sem bloqueio',
  CURRENT_TIMESTAMP(3)
);

INSERT INTO `AppVersionPolicy` (
  `platform`,
  `minSupportedVersion`,
  `minSupportedRuntimeVersion`,
  `minSupportedBuildNumber`,
  `forceUpdateEnabled`,
  `title`,
  `message`,
  `storeUrl`,
  `createdBy`,
  `notes`,
  `updatedAt`
) VALUES (
  'ios',
  '1.1.7',
  '1.1.7',
  7,
  false,
  'Atualizacao obrigatoria',
  'Uma nova versao do app esta disponivel. Atualize para continuar.',
  'https://apps.apple.com/br/app/idSEU_APP_ID',
  'migration-seed',
  'Baseline inicial sem bloqueio',
  CURRENT_TIMESTAMP(3)
);
