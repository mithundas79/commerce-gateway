BEGIN;

-- Refuse to choose an owner when an older deployment persisted conflicting aliases.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM connections c
    JOIN shopify_apps a ON a.tenant_id=c.tenant_id
    LEFT JOIN shopify_shop_owners o ON o.client_id=a.client_id AND o.shop=c.shop
    WHERE c.shopify_shop_id IS NOT NULL
      AND (c.shopify_shop_id !~ '^[1-9][0-9]{0,19}$' OR o.tenant_id IS DISTINCT FROM c.tenant_id)
  ) OR EXISTS (
    SELECT 1 FROM connections c
    JOIN shopify_apps a ON a.tenant_id=c.tenant_id
    WHERE c.shopify_shop_id IS NOT NULL
    GROUP BY a.client_id,c.shopify_shop_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SHOPIFY_IDENTITY_RECONCILIATION_REQUIRED: conflicting app/shop identity; preserve rows and follow release/shopify-lifecycle.md';
  END IF;
END $$;

CREATE TABLE shopify_shop_id_owners (
  client_id text NOT NULL,
  shop_id text NOT NULL CHECK (shop_id ~ '^[1-9][0-9]{0,19}$'),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  shop text NOT NULL,
  PRIMARY KEY (client_id,shop_id),
  UNIQUE (client_id,shop),
  FOREIGN KEY (client_id,shop) REFERENCES shopify_shop_owners(client_id,shop) ON DELETE CASCADE
);

INSERT INTO shopify_shop_id_owners(client_id,shop_id,tenant_id,shop)
SELECT a.client_id,c.shopify_shop_id,c.tenant_id,c.shop FROM connections c
JOIN shopify_apps a ON a.tenant_id=c.tenant_id WHERE c.shopify_shop_id IS NOT NULL;

COMMIT;
