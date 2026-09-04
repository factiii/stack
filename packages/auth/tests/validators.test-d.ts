import { describe, it, expectTypeOf } from 'vitest';
import { z } from 'zod';

import { createSchemas } from '../src/validators';

describe('createSchemas usernameMode types', () => {
  // Regression guard for 0.20.4. Between 0.20.0 and 0.20.3 `usernameMode` only
  // changed what the schema validated, never what it was typed as: the signup
  // type was pinned to the username-required base. An 'optional' consumer
  // therefore could not call register without passing a username it had
  // explicitly opted out of collecting.
  it('types username as optional under the optional mode', () => {
    const schemas = createSchemas(undefined, 'optional');
    expectTypeOf<z.infer<typeof schemas.signup>['username']>().toEqualTypeOf<string | undefined>();
  });

  it('types username as required under the required mode', () => {
    const schemas = createSchemas(undefined, 'required');
    expectTypeOf<z.infer<typeof schemas.signup>['username']>().toEqualTypeOf<string>();
  });

  it('defaults the type to optional, matching the runtime default', () => {
    const schemas = createSchemas();
    expectTypeOf<z.infer<typeof schemas.signup>['username']>().toEqualTypeOf<string | undefined>();
  });

  it('keeps extension fields alongside an optional username', () => {
    const schemas = createSchemas({ signup: z.object({ referralCode: z.string() }) }, 'optional');
    expectTypeOf<z.infer<typeof schemas.signup>>().toEqualTypeOf<{
      username?: string | undefined;
      email: string;
      password: string;
      referralCode: string;
    }>();
  });
});
