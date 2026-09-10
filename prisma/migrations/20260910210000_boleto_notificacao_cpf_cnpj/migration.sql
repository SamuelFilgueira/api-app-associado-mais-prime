-- Associado pessoa jurídica chega com CNPJ (14 dígitos) no campo cpf do SGA
-- AlterTable
ALTER TABLE `BoletoNotificacaoLog` MODIFY `cpf` VARCHAR(14) NOT NULL;
