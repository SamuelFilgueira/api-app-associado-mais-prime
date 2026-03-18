-- AlterTable
ALTER TABLE `Reinspection`
    MODIFY `status` ENUM('PENDENTE', 'EM_ANALISE', 'FINALIZADA', 'APROVADA', 'REPROVADA') NOT NULL DEFAULT 'PENDENTE';

-- AlterTable
ALTER TABLE `ReinspectionPhoto`
    ADD COLUMN `status` ENUM('APROVADA', 'REPROVADA') NOT NULL DEFAULT 'APROVADA';

-- CreateIndex
CREATE INDEX `ReinspectionPhoto_status_idx` ON `ReinspectionPhoto`(`status`);
