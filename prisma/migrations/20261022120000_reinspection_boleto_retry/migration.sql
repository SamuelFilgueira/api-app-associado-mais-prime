-- AlterTable
ALTER TABLE `Reinspection` ADD COLUMN `boletoNossoNumero` VARCHAR(50) NULL,
    ADD COLUMN `boletoOrigem` VARCHAR(20) NULL,
    ADD COLUMN `boletoProximaTentativaEm` DATETIME(3) NULL,
    ADD COLUMN `boletoRetryInicioEm` DATETIME(3) NULL,
    ADD COLUMN `boletoStatus` ENUM('NAO_GERADO', 'GERADO', 'PENDENTE_RETRY', 'FALHA') NOT NULL DEFAULT 'NAO_GERADO',
    ADD COLUMN `boletoTentativas` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `boletoUltimaTentativaEm` DATETIME(3) NULL,
    ADD COLUMN `boletoUltimoErro` VARCHAR(500) NULL;

-- AlterTable
ALTER TABLE `ReinspectionPayment` ADD COLUMN `reinspectionId` INTEGER NULL;

-- CreateIndex
CREATE INDEX `Reinspection_boletoStatus_idx` ON `Reinspection`(`boletoStatus`);

-- CreateIndex
CREATE INDEX `ReinspectionPayment_reinspectionId_idx` ON `ReinspectionPayment`(`reinspectionId`);

