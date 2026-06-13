-- AlterTable: optional community bio/description. Additive, nullable.
ALTER TABLE `Community` ADD COLUMN `bio` TEXT NULL;
