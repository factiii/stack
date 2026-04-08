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
  SessionWithUser,
} from './database';
export type { DeviceAuthAdapter, SessionWithDevice } from './deviceAuth';
export { createPrismaAdapter, createPrismaDeviceAdapter } from './prismaAdapter';
