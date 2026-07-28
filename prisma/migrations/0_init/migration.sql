-- CreateTable
CREATE TABLE `user` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `cpf` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `latitude` DOUBLE NULL,
    `longitude` DOUBLE NULL,
    `primeiroLogin` BOOLEAN NOT NULL DEFAULT false,
    `profilePhotoUrl` VARCHAR(191) NULL,
    `address` VARCHAR(191) NULL,
    `cep` VARCHAR(191) NULL,
    `plate` VARCHAR(191) NULL,
    `acceptsMarketingNotifications` BOOLEAN NOT NULL DEFAULT true,
    `notificacaoIgnicao` BOOLEAN NOT NULL DEFAULT false,
    `role` ENUM('USER', 'ADMIN') NOT NULL DEFAULT 'USER',
    `ancoraAtiva` BOOLEAN NOT NULL DEFAULT false,
    `expoPushToken` VARCHAR(255) NULL,
    `baseOrigin` VARCHAR(50) NULL,
    `totalEconomizado` DOUBLE NOT NULL DEFAULT 0,

    UNIQUE INDEX `User_cpf_key`(`cpf`),
    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workshop` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(150) NOT NULL,
    `email` VARCHAR(150) NULL,
    `shortDescription` VARCHAR(100) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `phoneSecondary` VARCHAR(191) NULL,
    `whatsapp` VARCHAR(191) NULL,
    `description` VARCHAR(400) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `featuredInApp` BOOLEAN NOT NULL DEFAULT false,
    `latitude` DOUBLE NULL,
    `longitude` DOUBLE NULL,
    `cep` VARCHAR(191) NOT NULL,
    `address` VARCHAR(191) NOT NULL,
    `district` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `complement` VARCHAR(191) NULL,
    `city` VARCHAR(191) NOT NULL,
    `state` ENUM('AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO') NOT NULL,
    `mapFrameUrl` VARCHAR(191) NULL,
    `photoFrontUrl` VARCHAR(191) NULL,
    `photoBackUrl` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `services` JSON NULL,
    `specialty` ENUM('CARRO', 'MOTO') NOT NULL DEFAULT 'CARRO',

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminPanelUser` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(150) NOT NULL,
    `password` VARCHAR(255) NOT NULL,
    `email` VARCHAR(150) NOT NULL,
    `role` ENUM('REVISTORIA', 'EVENTOS', 'MARKETING', 'COBRANCA', 'ADMIN') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AdminPanelUser_email_key`(`email`),
    INDEX `AdminPanelUser_role_idx`(`role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MarketingNotificationAuditLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `adminPanelUserId` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body` TEXT NOT NULL,
    `messagePayload` JSON NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'REQUESTED',
    `sentCount` INTEGER NULL,
    `skippedCount` INTEGER NULL,
    `errorMessage` VARCHAR(500) NULL,
    `normalizedAt` VARCHAR(19) NOT NULL,
    `normalizedTimezone` VARCHAR(64) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MarketingNotificationAuditLog_adminPanelUserId_idx`(`adminPanelUserId`),
    INDEX `MarketingNotificationAuditLog_requestedAt_idx`(`requestedAt`),
    INDEX `MarketingNotificationAuditLog_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnalyticsActionDaily` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `day` DATE NOT NULL,
    `platform` VARCHAR(10) NOT NULL,
    `appVersion` VARCHAR(20) NOT NULL,
    `action` VARCHAR(60) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AnalyticsActionDaily_appVersion_idx`(`appVersion`),
    INDEX `AnalyticsActionDaily_day_idx`(`day`),
    INDEX `AnalyticsActionDaily_platform_idx`(`platform`),
    UNIQUE INDEX `AnalyticsActionDaily_composite_key`(`day`, `platform`, `appVersion`, `action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnalyticsDailyUniqueInstall` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `day` DATE NOT NULL,
    `platform` VARCHAR(10) NOT NULL,
    `appVersion` VARCHAR(20) NOT NULL,
    `installHash` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AnalyticsDailyUniqueInstall_day_idx`(`day`),
    UNIQUE INDEX `AnalyticsDailyUniqueInstall_unique_key`(`day`, `platform`, `appVersion`, `installHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnalyticsDailyUniqueSession` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `day` DATE NOT NULL,
    `platform` VARCHAR(10) NOT NULL,
    `appVersion` VARCHAR(20) NOT NULL,
    `sessionHash` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AnalyticsDailyUniqueSession_day_idx`(`day`),
    UNIQUE INDEX `AnalyticsDailyUniqueSession_unique_key`(`day`, `platform`, `appVersion`, `sessionHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnalyticsFormDaily` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `day` DATE NOT NULL,
    `platform` VARCHAR(10) NOT NULL,
    `appVersion` VARCHAR(20) NOT NULL,
    `screen` VARCHAR(60) NOT NULL,
    `form` VARCHAR(60) NOT NULL,
    `startedCount` INTEGER NOT NULL DEFAULT 0,
    `submittedCount` INTEGER NOT NULL DEFAULT 0,
    `successCount` INTEGER NOT NULL DEFAULT 0,
    `errorCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AnalyticsFormDaily_appVersion_idx`(`appVersion`),
    INDEX `AnalyticsFormDaily_day_idx`(`day`),
    INDEX `AnalyticsFormDaily_platform_idx`(`platform`),
    UNIQUE INDEX `AnalyticsFormDaily_composite_key`(`day`, `platform`, `appVersion`, `screen`, `form`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnalyticsScreenDaily` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `day` DATE NOT NULL,
    `platform` VARCHAR(10) NOT NULL,
    `appVersion` VARCHAR(20) NOT NULL,
    `screen` VARCHAR(60) NOT NULL,
    `viewCount` INTEGER NOT NULL DEFAULT 0,
    `totalTimeMs` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AnalyticsScreenDaily_appVersion_idx`(`appVersion`),
    INDEX `AnalyticsScreenDaily_day_idx`(`day`),
    INDEX `AnalyticsScreenDaily_platform_idx`(`platform`),
    UNIQUE INDEX `AnalyticsScreenDaily_composite_key`(`day`, `platform`, `appVersion`, `screen`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnalyticsSessionDaily` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `day` DATE NOT NULL,
    `platform` VARCHAR(10) NOT NULL,
    `appVersion` VARCHAR(20) NOT NULL,
    `sessionsCount` INTEGER NOT NULL DEFAULT 0,
    `installsCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AnalyticsSessionDaily_day_idx`(`day`),
    UNIQUE INDEX `AnalyticsSessionDaily_composite_key`(`day`, `platform`, `appVersion`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnalyticsSummaryReceipt` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `periodStart` DATETIME(3) NOT NULL,
    `periodEnd` DATETIME(3) NOT NULL,
    `platform` VARCHAR(10) NOT NULL,
    `appVersion` VARCHAR(20) NOT NULL,
    `runtimeVersion` VARCHAR(20) NULL,
    `installHash` VARCHAR(64) NOT NULL,
    `sessionHash` VARCHAR(64) NOT NULL,
    `acceptedScreensCount` INTEGER NOT NULL DEFAULT 0,
    `acceptedActionsCount` INTEGER NOT NULL DEFAULT 0,
    `acceptedFormsCount` INTEGER NOT NULL DEFAULT 0,
    `discardedItemsCount` INTEGER NOT NULL DEFAULT 0,
    `validationStatus` VARCHAR(20) NOT NULL,
    `payloadHash` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `analyticsUserId` INTEGER NULL,

    INDEX `AnalyticsSummaryReceipt_appVersion_idx`(`appVersion`),
    INDEX `AnalyticsSummaryReceipt_payloadHash_idx`(`payloadHash`),
    INDEX `AnalyticsSummaryReceipt_periodStart_idx`(`periodStart`),
    INDEX `AnalyticsSummaryReceipt_platform_idx`(`platform`),
    INDEX `AnalyticsSummaryReceipt_receivedAt_idx`(`receivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Document` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `description` VARCHAR(255) NOT NULL,
    `documentUrl` VARCHAR(500) NOT NULL,
    `type` ENUM('TERMO_EVENTO', 'TERMO_PAYMENTS', 'TERMO_REVISTORIA', 'TERMO_USO_REGULAMENTO') NOT NULL,
    `visibleConsultor` BOOLEAN NOT NULL DEFAULT false,
    `visibleAssociado` BOOLEAN NOT NULL DEFAULT false,
    `visibleBoth` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FuelSession` (
    `id` VARCHAR(191) NOT NULL,
    `userId` INTEGER NOT NULL,
    `valorAntes` DOUBLE NOT NULL,
    `valorDepois` DOUBLE NULL,
    `diferenca` DOUBLE NULL,
    `status` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FuelSession_userId_status_idx`(`userId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `expoPushToken` VARCHAR(255) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body` TEXT NOT NULL,
    `data` JSON NOT NULL,
    `read` BOOLEAN NOT NULL DEFAULT false,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deleted` BOOLEAN NOT NULL DEFAULT false,

    INDEX `Notification_createdAt_idx`(`createdAt`),
    INDEX `Notification_sentAt_idx`(`sentAt`),
    INDEX `Notification_userId_read_idx`(`userId`, `read`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Reinspection` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userVehicleId` INTEGER NOT NULL,
    `vehicleType` ENUM('VEICULOS_LEVES', 'MOTOS', 'CAMINHOES') NOT NULL,
    `status` ENUM('PENDENTE', 'EM_ANALISE', 'FINALIZADA', 'APROVADA', 'REPROVADA') NOT NULL DEFAULT 'PENDENTE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `codigoVeiculo` INTEGER NULL,

    INDEX `Reinspection_status_idx`(`status`),
    INDEX `Reinspection_userVehicleId_idx`(`userVehicleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReinspectionAnalyst` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(150) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReinspectionPayment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userVehicleId` INTEGER NOT NULL,
    `nossoNumero` VARCHAR(50) NULL,
    `linhaDigitavel` VARCHAR(255) NULL,
    `linkBoleto` VARCHAR(500) NULL,
    `situacaoBoleto` VARCHAR(100) NOT NULL DEFAULT 'PENDENTE',
    `boletoCriadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `pago` BOOLEAN NOT NULL DEFAULT false,
    `pagoEm` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `cancelado` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `ReinspectionPayment_nossoNumero_key`(`nossoNumero`),
    INDEX `ReinspectionPayment_boletoCriadoEm_idx`(`boletoCriadoEm`),
    INDEX `ReinspectionPayment_pago_idx`(`pago`),
    INDEX `ReinspectionPayment_situacaoBoleto_idx`(`situacaoBoleto`),
    INDEX `ReinspectionPayment_userVehicleId_idx`(`userVehicleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReinspectionPhoto` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reinspectionId` INTEGER NOT NULL,
    `nomeArquivo` VARCHAR(255) NOT NULL,
    `codigoTipo` INTEGER NULL,
    `url` VARCHAR(500) NULL,
    `hinovaSituacao` VARCHAR(50) NULL,
    `sentToHinova` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `status` ENUM('PENDENTE', 'APROVADA', 'REPROVADA') NOT NULL,
    `templatePhotoId` INTEGER NULL,

    INDEX `ReinspectionPhoto_reinspectionId_idx`(`reinspectionId`),
    INDEX `ReinspectionPhoto_status_idx`(`status`),
    INDEX `ReinspectionPhoto_templatePhotoId_fkey`(`templatePhotoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReinspectionTemplatePhoto` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `vehicleType` ENUM('VEICULOS_LEVES', 'MOTOS', 'CAMINHOES') NOT NULL,
    `photoUrl` VARCHAR(500) NOT NULL,
    `ordem` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ReinspectionTemplatePhoto_vehicleType_idx`(`vehicleType`),
    UNIQUE INDEX `ReinspectionTemplatePhoto_vehicleType_ordem_key`(`vehicleType`, `ordem`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SliderInfo` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(255) NOT NULL,
    `subtitle` VARCHAR(255) NULL,
    `description` TEXT NOT NULL,
    `imageUrl` VARCHAR(500) NOT NULL,
    `whatsapp` VARCHAR(50) NULL,
    `linkUrl` VARCHAR(500) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserVehicle` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `chassi` VARCHAR(100) NOT NULL,
    `plate` VARCHAR(20) NULL,
    `externalVehicleCode` VARCHAR(50) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `lastSyncAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reinspectionRequired` BOOLEAN NOT NULL DEFAULT false,
    `cortarRastreamento` BOOLEAN NOT NULL DEFAULT false,

    INDEX `UserVehicle_chassi_idx`(`chassi`),
    INDEX `UserVehicle_userId_idx`(`userId`),
    UNIQUE INDEX `UserVehicle_userId_chassi_key`(`userId`, `chassi`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VehicleWebhookEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `chassi` VARCHAR(100) NOT NULL,
    `evento` VARCHAR(255) NULL,
    `tipoevento` INTEGER NULL,
    `provider` VARCHAR(32) NOT NULL DEFAULT 'M7',
    `payload` JSON NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processed` BOOLEAN NOT NULL DEFAULT false,

    INDEX `VehicleWebhookEvent_chassi_idx`(`chassi`),
    INDEX `VehicleWebhookEvent_receivedAt_idx`(`receivedAt`),
    INDEX `VehicleWebhookEvent_tipoevento_idx`(`tipoevento`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AppVersionPolicy` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `platform` VARCHAR(10) NOT NULL,
    `minSupportedVersion` VARCHAR(32) NOT NULL,
    `minSupportedRuntimeVersion` VARCHAR(32) NULL,
    `minSupportedVersionCode` INTEGER NULL,
    `minSupportedBuildNumber` INTEGER NULL,
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

-- CreateTable
CREATE TABLE `AppVersionValidationLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `requestId` CHAR(36) NULL,
    `platform` VARCHAR(10) NOT NULL,
    `appVersion` VARCHAR(32) NULL,
    `runtimeVersion` VARCHAR(32) NULL,
    `versionCode` INTEGER NULL,
    `buildNumber` INTEGER NULL,
    `policyId` INTEGER NULL,
    `blocked` BOOLEAN NOT NULL,
    `reason` VARCHAR(120) NULL,
    `userId` INTEGER NULL,
    `ipAddress` VARCHAR(45) NULL,
    `userAgent` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AppVersionValidationLog_createdAt_idx`(`createdAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotificationPopup` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `imageUrl` VARCHAR(191) NOT NULL,
    `linkUrl` VARCHAR(191) NULL,
    `linkLabel` VARCHAR(191) NULL DEFAULT 'Saiba mais',
    `active` BOOLEAN NOT NULL DEFAULT false,
    `userId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `NotificationPopup_active_createdAt_idx`(`active`, `createdAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MarketingNotificationAuditLog` ADD CONSTRAINT `MarketingNotificationAuditLog_adminPanelUserId_fkey` FOREIGN KEY (`adminPanelUserId`) REFERENCES `AdminPanelUser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FuelSession` ADD CONSTRAINT `FuelSession_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Reinspection` ADD CONSTRAINT `Reinspection_userVehicleId_fkey` FOREIGN KEY (`userVehicleId`) REFERENCES `UserVehicle`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReinspectionPayment` ADD CONSTRAINT `ReinspectionPayment_userVehicleId_fkey` FOREIGN KEY (`userVehicleId`) REFERENCES `UserVehicle`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReinspectionPhoto` ADD CONSTRAINT `ReinspectionPhoto_reinspectionId_fkey` FOREIGN KEY (`reinspectionId`) REFERENCES `Reinspection`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReinspectionPhoto` ADD CONSTRAINT `ReinspectionPhoto_templatePhotoId_fkey` FOREIGN KEY (`templatePhotoId`) REFERENCES `ReinspectionTemplatePhoto`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserVehicle` ADD CONSTRAINT `UserVehicle_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AppVersionValidationLog` ADD CONSTRAINT `AppVersionValidationLog_policyId_fkey` FOREIGN KEY (`policyId`) REFERENCES `AppVersionPolicy`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

