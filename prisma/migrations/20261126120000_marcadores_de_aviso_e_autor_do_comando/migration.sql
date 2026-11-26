-- Ajustes pedidos pelas frentes de boleto e de rastreamento. Só expansão:
-- colunas anuláveis novas e uma coluna que passa a aceitar nulo.

-- WhatsApp de boleto pago: marcador próprio de envio único (o e-mail já tem
-- `pagoNotificadoEm`).
ALTER TABLE `ReinspectionPayment`
  ADD COLUMN `suriNotificadoEm` DATETIME(3) NULL;

-- Auditoria de comando de veículo: o token do painel não tem id de
-- associado. `userId` fica nulo nesse caso e o usuário do painel vai em
-- `adminPanelUserId`.
ALTER TABLE `VeiculoComandoLog`
  MODIFY `userId` INTEGER NULL,
  ADD COLUMN `adminPanelUserId` INTEGER NULL;
