-- CreateTable
CREATE TABLE `DirectPartner` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(150) NOT NULL,
    `shortDescription` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `category` ENUM('AUTOMOTIVO', 'ALIMENTACAO', 'SAUDE', 'SERVICOS', 'LAZER', 'OUTROS') NOT NULL,
    `categoryLabel` VARCHAR(60) NULL,
    `alloyalCategoryIds` JSON NULL,
    `tone` ENUM('ACCENT', 'INFO', 'SUCCESS', 'WARNING', 'HIGHLIGHT') NOT NULL DEFAULT 'ACCENT',
    `logoUrl` VARCHAR(500) NULL,
    `coverUrl` VARCHAR(500) NULL,
    `street` VARCHAR(200) NOT NULL,
    `number` VARCHAR(20) NULL,
    `complement` VARCHAR(100) NULL,
    `district` VARCHAR(100) NOT NULL,
    `city` VARCHAR(100) NOT NULL,
    `state` ENUM('AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO') NOT NULL,
    `zipCode` VARCHAR(9) NOT NULL,
    `reference` VARCHAR(160) NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `phone` VARCHAR(20) NULL,
    `whatsapp` VARCHAR(20) NULL,
    `website` VARCHAR(300) NULL,
    `instagram` VARCHAR(100) NULL,
    `openingHoursText` VARCHAR(160) NULL,
    `openingHours` JSON NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `featured` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `DirectPartner_isActive_featured_sortOrder_idx`(`isActive`, `featured`, `sortOrder`),
    INDEX `DirectPartner_category_idx`(`category`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DirectPartnerBase` (
    `partnerId` INTEGER NOT NULL,
    `baseOrigin` VARCHAR(40) NOT NULL,

    INDEX `DirectPartnerBase_baseOrigin_idx`(`baseOrigin`),
    PRIMARY KEY (`partnerId`, `baseOrigin`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DirectPartnerCoupon` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `partnerId` INTEGER NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `highlight` VARCHAR(16) NOT NULL,
    `title` VARCHAR(80) NOT NULL,
    `description` VARCHAR(300) NOT NULL,
    `conditions` JSON NOT NULL,
    `validFrom` DATETIME(3) NULL,
    `validUntil` DATETIME(3) NOT NULL,
    `singleUse` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `DirectPartnerCoupon_partnerId_isActive_validUntil_idx`(`partnerId`, `isActive`, `validUntil`),
    UNIQUE INDEX `DirectPartnerCoupon_partnerId_code_key`(`partnerId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DirectPartnerCouponRedemption` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `couponId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `baseOrigin` VARCHAR(40) NOT NULL,
    `redeemedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DirectPartnerCouponRedemption_couponId_userId_idx`(`couponId`, `userId`),
    INDEX `DirectPartnerCouponRedemption_userId_redeemedAt_idx`(`userId`, `redeemedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DirectPartnerBase` ADD CONSTRAINT `DirectPartnerBase_partnerId_fkey` FOREIGN KEY (`partnerId`) REFERENCES `DirectPartner`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DirectPartnerCoupon` ADD CONSTRAINT `DirectPartnerCoupon_partnerId_fkey` FOREIGN KEY (`partnerId`) REFERENCES `DirectPartner`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DirectPartnerCouponRedemption` ADD CONSTRAINT `DirectPartnerCouponRedemption_couponId_fkey` FOREIGN KEY (`couponId`) REFERENCES `DirectPartnerCoupon`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DirectPartnerCouponRedemption` ADD CONSTRAINT `DirectPartnerCouponRedemption_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

