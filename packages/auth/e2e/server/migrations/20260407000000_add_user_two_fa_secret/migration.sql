-- Adds standard-mode 2FA columns to the User table.
-- See packages/auth/prisma/schema.standard.prisma for the reference shape.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "twoFaSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "twoFaBackupCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];
