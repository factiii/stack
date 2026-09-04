/**
 * Linked-OAuth-provider storage adapter for @factiii/auth.
 *
 * Required when OAuth is enabled. `resolve` is the source of truth for OAuth
 * sign-in, and one account can link several providers (e.g. both Google and
 * Apple). See `prisma/schema.*.prisma` for the reference `OAuthAccount` model.
 */
export interface OAuthAccountAdapter {
  /** Resolve a linked provider identity to its account. Null if not linked. */
  resolve(provider: 'GOOGLE' | 'APPLE', subject: string): Promise<{ userId: number } | null>;

  /** Attach a provider identity to a user (idempotent for the same user). */
  link(
    userId: number,
    data: { provider: 'GOOGLE' | 'APPLE'; subject: string; email: string | null }
  ): Promise<void>;

  /** Detach a provider from a user. */
  unlink(userId: number, provider: 'GOOGLE' | 'APPLE'): Promise<void>;

  /** List a user's linked providers — powers the keep-one-method guard. */
  list(userId: number): Promise<Array<'GOOGLE' | 'APPLE'>>;
}
