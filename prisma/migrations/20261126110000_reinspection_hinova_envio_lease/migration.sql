-- Lease do envio de fotos da revistoria à Hinova (coluna anulável; nenhuma
-- linha existente é alterada). Enquanto `hinovaEnvioLeaseAte` estiver no
-- futuro, um segundo envio da mesma revistoria é recusado.
-- AlterTable
ALTER TABLE `Reinspection` ADD COLUMN `hinovaEnvioLeaseAte` DATETIME(3) NULL;
