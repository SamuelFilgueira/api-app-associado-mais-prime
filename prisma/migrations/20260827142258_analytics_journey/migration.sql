-- AlterTable
ALTER TABLE `AnalyticsSummaryReceipt` ADD COLUMN `journeyEventsCount` INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX `AnalyticsSummaryReceipt_user_receivedAt_idx` ON `AnalyticsSummaryReceipt`(`analyticsUserId`, `receivedAt`);

-- CreateIndex
CREATE INDEX `AnalyticsSummaryReceipt_install_receivedAt_idx` ON `AnalyticsSummaryReceipt`(`installHash`, `receivedAt`);

-- CreateTable
CREATE TABLE `AnalyticsDevice` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `installHash` VARCHAR(64) NOT NULL,
    `platform` VARCHAR(10) NOT NULL,
    `brand` VARCHAR(40) NULL,
    `model` VARCHAR(80) NULL,
    `modelId` VARCHAR(40) NULL,
    `osName` VARCHAR(20) NULL,
    `osVersion` VARCHAR(20) NULL,
    `deviceType` VARCHAR(20) NULL,
    `timezone` VARCHAR(60) NULL,
    `appVersion` VARCHAR(20) NOT NULL,
    `runtimeVersion` VARCHAR(20) NULL,
    `lastSessionHash` VARCHAR(64) NULL,
    `lastUserId` INTEGER NULL,
    `lastIp` VARCHAR(45) NULL,
    `summariesCount` INTEGER NOT NULL DEFAULT 0,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AnalyticsDevice_installHash_key`(`installHash`),
    INDEX `AnalyticsDevice_lastUserId_idx`(`lastUserId`),
    INDEX `AnalyticsDevice_lastSeenAt_idx`(`lastSeenAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnalyticsUserDevice` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `installHash` VARCHAR(64) NOT NULL,
    `platform` VARCHAR(10) NOT NULL,
    `lastAppVersion` VARCHAR(20) NOT NULL,
    `lastSessionHash` VARCHAR(64) NULL,
    `summariesCount` INTEGER NOT NULL DEFAULT 0,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastLoginAt` DATETIME(3) NULL,
    `lastLogoutAt` DATETIME(3) NULL,

    UNIQUE INDEX `AnalyticsUserDevice_user_install_key`(`userId`, `installHash`),
    INDEX `AnalyticsUserDevice_installHash_idx`(`installHash`),
    INDEX `AnalyticsUserDevice_user_lastSeenAt_idx`(`userId`, `lastSeenAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnalyticsJourneyEvent` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `occurredAt` DATETIME(3) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `receiptId` INTEGER NULL,
    `userId` INTEGER NULL,
    `installHash` VARCHAR(64) NOT NULL,
    `sessionHash` VARCHAR(64) NOT NULL,
    `platform` VARCHAR(10) NOT NULL,
    `appVersion` VARCHAR(20) NOT NULL,
    `seq` INTEGER NOT NULL DEFAULT 0,
    `eventType` ENUM('SCREEN', 'ACTION', 'FORM') NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `screen` VARCHAR(80) NULL,
    `outcome` VARCHAR(20) NULL,
    `durationMs` INTEGER NULL,

    INDEX `AnalyticsJourneyEvent_user_occurredAt_idx`(`userId`, `occurredAt`),
    INDEX `AnalyticsJourneyEvent_install_occurredAt_idx`(`installHash`, `occurredAt`),
    INDEX `AnalyticsJourneyEvent_sessionHash_idx`(`sessionHash`),
    INDEX `AnalyticsJourneyEvent_occurredAt_idx`(`occurredAt`),
    INDEX `AnalyticsJourneyEvent_name_occurredAt_idx`(`name`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
