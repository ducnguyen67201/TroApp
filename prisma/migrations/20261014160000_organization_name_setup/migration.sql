-- Preserve existing organization names as permanent; new grants await owner setup.
ALTER TABLE "organization" ADD COLUMN "nameSetAt" TIMESTAMP(3);
UPDATE "organization" SET "nameSetAt" = "createdAt";

-- A confirmed name and its lock cannot be changed, including during ownership transfer.
CREATE FUNCTION "preserve_organization_name"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."nameSetAt" IS NOT NULL AND (
    NEW."name" IS DISTINCT FROM OLD."name" OR
    NEW."nameSetAt" IS DISTINCT FROM OLD."nameSetAt"
  ) THEN
    RAISE EXCEPTION 'Organization name is permanent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "organization_name_is_permanent"
  BEFORE UPDATE ON "organization"
  FOR EACH ROW EXECUTE FUNCTION "preserve_organization_name"();
