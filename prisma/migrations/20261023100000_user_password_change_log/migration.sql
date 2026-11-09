-- CreateTable
CREATE TABLE `UserPasswordChangeLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `userCpf` VARCHAR(20) NOT NULL,
    `userEmail` VARCHAR(150) NULL,
    `userName` VARCHAR(150) NULL,
    `origem` VARCHAR(20) NOT NULL,
    `adminPanelUserId` INTEGER NULL,
    `adminPanelUserEmail` VARCHAR(150) NULL,
    `adminPanelUserRole` VARCHAR(30) NULL,
    `ipAddress` VARCHAR(45) NULL,
    `userAgent` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `UserPasswordChangeLog_userId_idx`(`userId`),
    INDEX `UserPasswordChangeLog_adminPanelUserId_idx`(`adminPanelUserId`),
    INDEX `UserPasswordChangeLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

