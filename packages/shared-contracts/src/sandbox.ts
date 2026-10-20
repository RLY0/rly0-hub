import { z } from "zod";

const localProxy = z
  .string()
  .max(300)
  .refine((value) => {
    const match = /^(?:http|socks5h):\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/u.exec(
      value,
    );
    return Boolean(match && Number(match[1]) > 0 && Number(match[1]) <= 65535);
  }, "Use a local HTTP or SOCKS5h proxy without credentials");

export const sandboxProjectSchema = z
  .object({
    id: z.string().min(1).max(100),
    project: z.string().min(3).max(2000),
    name: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}$/u),
  })
  .strict();

export const sandboxSettingsSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    runtimeRoot: z.string().min(3).max(2000),
    proxy: localProxy,
    projects: z.array(sandboxProjectSchema).max(100),
  })
  .strict();
export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;
export type SandboxProject = z.infer<typeof sandboxProjectSchema>;

export const sandboxConfigureSchema = sandboxSettingsSchema.omit({ version: true, projects: true });
export const sandboxPrepareSchema = z
  .object({
    project: z.string().min(3).max(2000),
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,62}$/u)
      .optional(),
  })
  .strict();
export const sandboxSelectSchema = z.object({ project: z.string().min(3).max(2000) }).strict();
export const sandboxLoginIdSchema = z.object({ id: z.string().uuid() }).strict();
export const sandboxLoginSubmitSchema = sandboxLoginIdSchema
  .extend({
    code: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((value) => !/\s/u.test(value)),
  })
  .strict();
