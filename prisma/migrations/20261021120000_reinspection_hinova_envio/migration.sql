-- AlterTable
ALTER TABLE `Reinspection` ADD COLUMN `hinovaEnvioStatus` ENUM('NAO_ENVIADA', 'ENVIADA', 'PARCIAL', 'FALHA') NOT NULL DEFAULT 'NAO_ENVIADA',
    ADD COLUMN `hinovaUltimoEnvioEm` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `ReinspectionPhoto` ADD COLUMN `hinovaEnviadaEm` DATETIME(3) NULL,
    ADD COLUMN `hinovaTentativas` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `hinovaUltimoErro` VARCHAR(500) NULL;

-- CreateTable
CREATE TABLE `ReinspectionHinovaEnvio` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reinspectionId` INTEGER NOT NULL,
    `origem` ENUM('APROVACAO', 'REENVIO_MANUAL') NOT NULL,
    `status` ENUM('NAO_ENVIADA', 'ENVIADA', 'PARCIAL', 'FALHA') NOT NULL,
    `baseOrigin` VARCHAR(30) NOT NULL,
    `codigoVeiculo` INTEGER NULL,
    `adminPanelUserId` INTEGER NULL,
    `adminPanelUserEmail` VARCHAR(150) NULL,
    `totalFotos` INTEGER NOT NULL DEFAULT 0,
    `totalInseridas` INTEGER NOT NULL DEFAULT 0,
    `totalFalhas` INTEGER NOT NULL DEFAULT 0,
    `photoIds` JSON NOT NULL,
    `httpStatus` INTEGER NULL,
    `responseBody` JSON NULL,
    `errorMessage` VARCHAR(500) NULL,
    `duracaoMs` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReinspectionHinovaEnvio_reinspectionId_idx`(`reinspectionId`),
    INDEX `ReinspectionHinovaEnvio_createdAt_idx`(`createdAt`),
    INDEX `ReinspectionHinovaEnvio_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Reinspection_hinovaEnvioStatus_idx` ON `Reinspection`(`hinovaEnvioStatus`);

-- AddForeignKey
ALTER TABLE `ReinspectionHinovaEnvio` ADD CONSTRAINT `ReinspectionHinovaEnvio_reinspectionId_fkey` FOREIGN KEY (`reinspectionId`) REFERENCES `Reinspection`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

