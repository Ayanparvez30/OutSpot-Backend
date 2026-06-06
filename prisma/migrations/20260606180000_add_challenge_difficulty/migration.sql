-- Add ChallengeDifficulty enum + nullable difficulty column on Challenge.
-- Existing rows have difficulty=NULL and behave exactly as before.
ALTER TABLE `Challenge`
  ADD COLUMN `difficulty` ENUM('EASY','MEDIUM','HARD','MULTI_STEP') NULL;
