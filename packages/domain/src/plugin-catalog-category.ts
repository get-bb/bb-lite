import { z } from "zod";

export const PLUGIN_CATALOG_CATEGORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export const pluginCatalogCategoryIdSchema = z
  .string()
  .regex(PLUGIN_CATALOG_CATEGORY_ID_PATTERN);

export const pluginMarketplaceCollectionIdSchema = z
  .string()
  .regex(PLUGIN_CATALOG_CATEGORY_ID_PATTERN);

export const pluginMarketplaceCollectionPluginIdSchema = z
  .string()
  .regex(PLUGIN_CATALOG_CATEGORY_ID_PATTERN);

export const pluginMarketplaceCategorySchema = z.object({
  id: pluginCatalogCategoryIdSchema,
  displayName: z.string().min(1),
  description: z.string().min(1),
});

export const pluginMarketplaceCollectionSchema = z.object({
  id: pluginMarketplaceCollectionIdSchema,
  displayName: z.string().min(1),
  pluginIds: z
    .array(pluginMarketplaceCollectionPluginIdSchema)
    .superRefine((pluginIds, ctx) => {
      const seen = new Set<string>();
      pluginIds.forEach((pluginId, index) => {
        if (seen.has(pluginId)) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message: `duplicate plugin id "${pluginId}"`,
          });
        }
        seen.add(pluginId);
      });
    }),
});

export type PluginMarketplaceCategory = z.infer<
  typeof pluginMarketplaceCategorySchema
>;
export type PluginMarketplaceCollection = z.infer<
  typeof pluginMarketplaceCollectionSchema
>;
