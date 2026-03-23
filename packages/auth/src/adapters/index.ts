export type { EmailAdapter } from './email';
export { createConsoleEmailAdapter, createNoopEmailAdapter } from './email';

export type {
  AuthOTP,
  AuthPasswordReset,
  AuthSession,
  AuthUser,
  CreateSessionData,
  CreateUserData,
  DatabaseAdapter,
  SessionWithDevice,
  SessionWithUser,
} from './database';
export { createPrismaAdapter } from './prismaAdapter';
