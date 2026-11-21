import { z } from 'zod';

export const catalogItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  price: z.number().nonnegative(),
  currency: z.string().min(1),
  stock: z.boolean().default(true),
  description: z.string().optional(),
  attributes: z.record(z.unknown()).default({}),
  images: z.array(z.string().url()).default([]),
});

export const businessProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  vertical: z.string().min(1),
  language: z.enum(['es', 'pt', 'en']).default('es'),
  timezone: z.string().min(1),
  tone: z.string().min(1),
  hours: z.record(z.string()).default({}),
  locations: z.array(z.string()).default([]),
  policies: z.record(z.unknown()).default({}),
});

export const businessPackSchema = z.object({
  profile: businessProfileSchema,
  catalog: z.array(catalogItemSchema).default([]),
  prompt: z
    .object({
      persona: z.string().optional(),
      rules: z.array(z.string()).default([]),
    })
    .optional(),
});

export type CatalogItem = z.infer<typeof catalogItemSchema>;
export type BusinessProfile = z.infer<typeof businessProfileSchema>;
export type BusinessPack = z.infer<typeof businessPackSchema>;
