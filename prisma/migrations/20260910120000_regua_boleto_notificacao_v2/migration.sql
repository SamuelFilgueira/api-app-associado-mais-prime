-- Régua v2 (documento do gestor, 10/09/2026): novas etapas DM5 (D-5), D1 (D+1) e D20 (D+20)
-- AlterTable
ALTER TABLE `BoletoNotificacaoExecucao` MODIFY `tipoMensagem` ENUM('DM5', 'D0', 'D1', 'D5', 'D6', 'D20') NOT NULL;

-- AlterTable
ALTER TABLE `BoletoNotificacaoLog` MODIFY `tipoMensagem` ENUM('DM5', 'D0', 'D1', 'D5', 'D6', 'D20') NOT NULL;
