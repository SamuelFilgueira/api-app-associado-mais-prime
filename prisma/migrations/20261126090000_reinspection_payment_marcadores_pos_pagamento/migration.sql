-- Marcadores de idempotência do pós-pagamento do boleto de reativação.
-- `reativadoEm`: o SGA aceitou a reativação do veículo (o poller só encerra depois disso).
-- `pagoNotificadoEm`: e-mail de "boleto pago" já enviado à equipe.
-- AlterTable
ALTER TABLE `ReinspectionPayment`
    ADD COLUMN `reativadoEm` DATETIME(3) NULL,
    ADD COLUMN `pagoNotificadoEm` DATETIME(3) NULL;

-- Pagamentos já concluídos antes desta migration: o fluxo antigo encerrava o
-- poller logo após o pagamento, então não há o que reprocessar.
UPDATE `ReinspectionPayment`
   SET `reativadoEm` = COALESCE(`pagoEm`, `updatedAt`),
       `pagoNotificadoEm` = COALESCE(`pagoEm`, `updatedAt`)
 WHERE `pago` = true;
