-- Boleto de reativação com encargos por atraso (regra por empresa; hoje só a
-- Hertz). Guarda a memória de cálculo junto do boleto: valor base, multa,
-- mora, dias de atraso, o boleto em aberto que serviu de base e a situação
-- do cancelamento dele. Coluna anulável: só expansão.
ALTER TABLE `ReinspectionPayment`
  ADD COLUMN `encargos` JSON NULL;
