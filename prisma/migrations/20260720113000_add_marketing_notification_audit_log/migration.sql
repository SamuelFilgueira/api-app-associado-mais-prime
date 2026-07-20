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

-- AddForeignKey
ALTER TABLE `MarketingNotificationAuditLog`
ADD CONSTRAINT `MarketingNotificationAuditLog_adminPanelUserId_fkey`
FOREIGN KEY (`adminPanelUserId`) REFERENCES `AdminPanelUser`(`id`)
ON DELETE RESTRICT ON UPDATE CASCADE;
