/**
 * Prebuilt Prisma adapters for the multi-method optional features, mirroring
 * `createPrismaDeviceAdapter`. The pure CRUD is generic; only the genuinely
 * app-specific pieces (user creation/provisioning, ephemeral challenge storage)
 * are injected. Target the reference `Passkey` / `OAuthAccount` models in
 * `prisma/schema.*.prisma`.
 */
import type { PasskeyRegisterInput, SchemaExtensions } from '../types/hooks';
import type { OAuthAccountAdapter } from './oauthAccount';
import type { PasskeyAdapter } from './passkey';

type PrismaDelegate = Record<string, (...args: unknown[]) => Promise<unknown>>;
interface MultiMethodPrisma {
  passkey: PrismaDelegate;
  oAuthAccount: PrismaDelegate;
}

const PROVIDERS = ['GOOGLE', 'APPLE'] as const;

/**
 * OAuthAccount storage backed by Prisma — fully generic, no options.
 * The `OAuthAccount` table is the sole source of truth. Pass as `oauthAccounts`
 * on AuthConfig.
 */
export function createPrismaOAuthAccountAdapter(prisma: unknown): OAuthAccountAdapter {
  const db = prisma as MultiMethodPrisma;
  return {
    async resolve(provider, subject) {
      const link = (await db.oAuthAccount.findUnique({
        where: { provider_providerSubject: { provider, providerSubject: subject } },
        select: { userId: true },
      })) as { userId: number } | null;
      return link ? { userId: link.userId } : null;
    },

    async link(userId, data) {
      // Upsert so re-recording the same identity is a no-op, not a conflict.
      await db.oAuthAccount.upsert({
        where: {
          provider_providerSubject: {
            provider: data.provider,
            providerSubject: data.subject,
          },
        },
        create: {
          userId,
          provider: data.provider,
          providerSubject: data.subject,
          email: data.email,
        },
        update: {},
      });
    },

    async unlink(userId, provider) {
      await db.oAuthAccount.deleteMany({ where: { userId, provider } });
    },

    async list(userId) {
      const links = (await db.oAuthAccount.findMany({
        where: { userId },
        select: { provider: true },
      })) as Array<{ provider: 'GOOGLE' | 'APPLE' }>;
      const set = new Set<string>(links.map((l) => l.provider));
      return PROVIDERS.filter((p) => set.has(p));
    },
  };
}

/** App-specific pieces of a passkey adapter that can't be generic. */
export interface PrismaPasskeyAdapterOptions<TExtensions extends SchemaExtensions = {}> {
  /** Create the user + persist the first credential; return the new userId.
   * (User creation + provisioning is app-specific, so you own it.) */
  createUser: (input: PasskeyRegisterInput<TExtensions>) => Promise<{ userId: number }>;
  /** Short-lived challenge storage (e.g. Redis). */
  challenge: Pick<PasskeyAdapter<TExtensions>, 'storeChallenge' | 'consumeChallenge'>;
}

/**
 * Passkey storage backed by Prisma. The credential CRUD (list/add/remove/
 * resolveCredential/onAuthenticated/has) is generic; you inject `createUser`
 * and the `challenge` store. Pass as `passkey` on AuthConfig.
 */
export function createPrismaPasskeyAdapter<TExtensions extends SchemaExtensions = {}>(
  prisma: unknown,
  opts: PrismaPasskeyAdapterOptions<TExtensions>
): PasskeyAdapter<TExtensions> {
  const db = prisma as MultiMethodPrisma;
  return {
    storeChallenge: opts.challenge.storeChallenge,
    consumeChallenge: opts.challenge.consumeChallenge,
    createUser: opts.createUser,

    async resolveCredential(credentialId) {
      const pk = (await db.passkey.findUnique({
        where: { credentialId },
        select: { userId: true, publicKey: true, counter: true, transports: true },
      })) as {
        userId: number;
        publicKey: Uint8Array;
        counter: bigint;
        transports: string[];
      } | null;
      if (!pk) return null;
      return {
        userId: pk.userId,
        publicKey: new Uint8Array(pk.publicKey),
        counter: Number(pk.counter),
        transports: pk.transports,
      };
    },

    async onAuthenticated(credentialId, newCounter) {
      await db.passkey.update({
        where: { credentialId },
        data: { counter: BigInt(newCounter), lastUsedAt: new Date() },
      });
    },

    async has(userId) {
      const count = (await db.passkey.count({ where: { userId } })) as unknown as number;
      return count > 0;
    },

    async list(userId) {
      return db.passkey.findMany({
        where: { userId },
        select: {
          id: true,
          credentialId: true,
          transports: true,
          name: true,
          createdAt: true,
          lastUsedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }) as Promise<
        Array<{
          id: string;
          credentialId: string;
          transports: string[];
          name: string | null;
          createdAt: Date;
          lastUsedAt: Date | null;
        }>
      >;
    },

    async add(userId, credential) {
      const pk = (await db.passkey.create({
        data: {
          credentialId: credential.credentialId,
          publicKey: Buffer.from(credential.publicKey),
          counter: BigInt(credential.counter),
          transports: credential.transports,
          deviceType: credential.deviceType,
          backedUp: credential.backedUp,
          name: credential.name ?? null,
          userId,
        },
        select: { id: true },
      })) as { id: string };
      return { id: pk.id };
    },

    async remove(userId, id) {
      await db.passkey.deleteMany({ where: { id, userId } });
    },
  };
}
