import type { z } from 'zod';

/**
 * Any object schema, whatever its shape.
 *
 * zod 3 exported this as `AnyZodObject`; zod 4 removed it, so we name the
 * zod 4 equivalent here rather than repeating `z.ZodObject<z.ZodRawShape>`
 * at every use site.
 */
export type AnyZodObject = z.ZodObject<z.ZodRawShape>;
