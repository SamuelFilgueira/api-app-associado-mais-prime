-- Disparo de push agendado (colunas opcionais no log de marketing) e log de
-- inclusão/alteração de pop-up. Só adiciona: nenhuma coluna existente muda.

-- AlterTable
ALTER TABLE `MarketingNotificationAuditLog` ADD COLUMN `canceledAt` DATETIME(3) NULL,
    ADD COLUMN `canceledByAdminPanelUserId` INTEGER NULL,
    ADD COLUMN `scheduledFor` DATETIME(3) NULL,
    ADD COLUMN `tipo` VARCHAR(30) NOT NULL DEFAULT 'MARKETING';

-- CreateTable
CREATE TABLE `NotificationPopupAuditLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `popupId` INTEGER NOT NULL,
    `acao` VARCHAR(20) NOT NULL,
    `adminPanelUserId` INTEGER NULL,
    `adminName` VARCHAR(150) NULL,
    `adminEmail` VARCHAR(150) NULL,
    `imageUrl` TEXT NULL,
    `linkUrl` TEXT NULL,
    `linkLabel` VARCHAR(191) NULL,
    `active` BOOLEAN NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `NotificationPopupAuditLog_popupId_idx`(`popupId`),
    INDEX `NotificationPopupAuditLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `MarketingNotificationAuditLog_status_scheduledFor_idx` ON `MarketingNotificationAuditLog`(`status`, `scheduledFor`);

