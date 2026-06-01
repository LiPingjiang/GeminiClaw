// @ts-nocheck
// src/templates/schema.ts
import { z } from "zod";
export const templateMetaSchema = z.object({
    name: z.string().min(1),
    display_name: z.string().optional(),
    description: z.string().default(""),
    keywords: z.array(z.string()).default([]),
    created_at: z.union([z.string(), z.date().transform((d) => d.toISOString())]).optional(),
    copied_from: z.string().optional(),
});
