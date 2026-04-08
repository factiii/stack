-- E2E baseline schema for @factiii/auth.
-- Standard 2FA mode (default): TOTP secret + backup codes live on the user;
-- 2FA is "on" iff `twoFaSecret IS NOT NULL`. No `Device` table, no per-session
-- 2FA columns. This file is the only migration the e2e suite needs — the
-- @factiii/auth package isn't published to consumers from these migrations,
-- so prior incremental history was collapsed away.

-- ── Enums ────────────────────────────────────────────────────────────────────
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DEACTIVATED', 'BANNED');
CREATE TYPE "UserTag" AS ENUM ('HUMAN', 'BOT');
CREATE TYPE "EmailVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED');
CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE', 'APPLE');

-- ── User ─────────────────────────────────────────────────────────────────────
CREATE TABLE "User" (
    "id" SERIAL PRIMARY KEY,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "email" TEXT NOT NULL,
    "emailVerificationStatus" "EmailVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "password" TEXT,
    "username" TEXT NOT NULL,
    "twoFaSecret" TEXT,
    "twoFaBackupCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "oauthProvider" "OAuthProvider",
    "oauthId" TEXT,
    "tag" "UserTag" NOT NULL DEFAULT 'HUMAN',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "verifiedHumanAt" TIMESTAMP(3),
    "otpForEmailVerification" TEXT
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- ── Session ──────────────────────────────────────────────────────────────────
CREATE TABLE "Session" (
    "id" SERIAL PRIMARY KEY,
    "socketId" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "browserName" TEXT NOT NULL DEFAULT 'Unknown',
    "lastUsed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Session_socketId_key" ON "Session"("socketId");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- ── Admin ────────────────────────────────────────────────────────────────────
CREATE TABLE "Admin" (
    "ip" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    CONSTRAINT "Admin_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "Admin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ── PasswordReset ────────────────────────────────────────────────────────────
CREATE TABLE "PasswordReset" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "invalidatedAt" TIMESTAMP(3),
    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PasswordReset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PasswordReset_userId_idx" ON "PasswordReset"("userId");

-- ── OTP ──────────────────────────────────────────────────────────────────────
CREATE TABLE "OTP" (
    "id" SERIAL PRIMARY KEY,
    "code" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "userId" INTEGER NOT NULL,
    CONSTRAINT "OTP_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "OTP_userId_idx" ON "OTP"("userId");
