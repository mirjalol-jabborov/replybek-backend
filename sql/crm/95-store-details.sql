-- Replybek CRM, the Store module: a product's description and its gallery.
-- Runs after 20-store.sql and, like every CRM file, can run again and again. Additive only: two
-- columns with defaults and an index; no row is changed.

-- What the business says about a product, as typed (plain text, line breaks kept, up to 2000).
ALTER TABLE crm_products ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
-- The photos after the main one (`image`), in their order: ["/w/<wid>/crm/products/images/<uuid>.jpg", ...].
-- A product shows at most 8 photos, the main one included. Old products have [] and keep their `image`.
ALTER TABLE crm_products ADD COLUMN IF NOT EXISTS gallery JSONB NOT NULL DEFAULT '[]'::jsonb;
-- "Does a product still show this picture?" for the photos after the main one (src/crm/store/images.js).
CREATE INDEX IF NOT EXISTS crm_products_gallery ON crm_products USING gin (gallery jsonb_path_ops);
