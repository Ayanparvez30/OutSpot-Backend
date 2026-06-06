-- Scheduling constraints on Challenge so weekend / seasonal challenges only
-- surface during their valid windows.
ALTER TABLE `Challenge`
  ADD COLUMN `weekendOnly` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `season` VARCHAR(191) NULL;
