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
