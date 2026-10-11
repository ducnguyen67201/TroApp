-- Additive personal wallets/worlds. Existing users, pets and classroom records are unchanged.
CREATE TABLE "PetWallet" (
  "studentId" TEXT NOT NULL,
  "balance" BIGINT NOT NULL DEFAULT 0,
  "revision" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "PetWallet_pkey" PRIMARY KEY ("studentId"),
  CONSTRAINT "PetWallet_balance_nonnegative" CHECK ("balance" >= 0),
  CONSTRAINT "PetWallet_revision_nonnegative" CHECK ("revision" >= 0)
);

CREATE TABLE "PetRecognition" (
  "id" UUID NOT NULL,
  "classId" UUID NOT NULL,
  "teacherId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "batchId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "amount" BIGINT NOT NULL,
  "category" TEXT NOT NULL,
  "note" TEXT,
  "sessionId" UUID,
  "activityId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PetRecognition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PetRecognition_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "PetRecognition_distinct_teacher_student" CHECK ("teacherId" <> "studentId")
);

CREATE TABLE "PetRecognitionCorrection" (
  "id" UUID NOT NULL,
  "recognitionId" UUID NOT NULL,
  "teacherId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PetRecognitionCorrection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PetRecognitionCorrection_kind" CHECK ("kind" IN ('reversed', 'voided')),
  CONSTRAINT "PetRecognitionCorrection_stable_source" CHECK ("id" = "recognitionId")
);

CREATE TABLE "PetPurchase" (
  "id" UUID NOT NULL,
  "studentId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "catalogRevision" TEXT NOT NULL,
  "requestId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PetPurchase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PetPurchase_amount_positive" CHECK ("amount" > 0)
);

CREATE TABLE "PetInventoryItem" (
  "studentId" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "purchaseId" UUID NOT NULL,
  "acquiredAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PetInventoryItem_pkey" PRIMARY KEY ("studentId", "itemId")
);

CREATE TABLE "PetWalletEntry" (
  "id" UUID NOT NULL,
  "studentId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "delta" BIGINT NOT NULL,
  "sourceId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "recognitionId" UUID,
  "purchaseId" UUID,
  "correctionId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PetWalletEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PetWalletEntry_source_and_sign" CHECK (
    ("kind" = 'teacher_grant' AND "delta" > 0 AND "recognitionId" IS NOT NULL
      AND "sourceId" = "recognitionId" AND "purchaseId" IS NULL AND "correctionId" IS NULL)
    OR ("kind" = 'purchase' AND "delta" < 0 AND "purchaseId" IS NOT NULL
      AND "sourceId" = "purchaseId" AND "recognitionId" IS NULL AND "correctionId" IS NULL)
    OR ("kind" = 'grant_reversal' AND "delta" < 0 AND "recognitionId" IS NOT NULL
      AND "correctionId" IS NOT NULL AND "sourceId" = "correctionId" AND "purchaseId" IS NULL)
  )
);

CREATE TABLE "PetWorld" (
  "studentId" TEXT NOT NULL,
  "revision" BIGINT NOT NULL,
  "document" JSONB NOT NULL,
  CONSTRAINT "PetWorld_pkey" PRIMARY KEY ("studentId"),
  CONSTRAINT "PetWorld_revision_nonnegative" CHECK ("revision" >= 0)
);

CREATE TABLE "PetHomeShare" (
  "studentId" TEXT NOT NULL,
  "classId" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "revision" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "PetHomeShare_pkey" PRIMARY KEY ("studentId", "classId"),
  CONSTRAINT "PetHomeShare_revision_nonnegative" CHECK ("revision" >= 0)
);

CREATE TABLE "PetWorldReceipt" (
  "actorId" TEXT NOT NULL,
  "requestId" UUID NOT NULL,
  "digest" VARCHAR(64) NOT NULL,
  "scopeKind" TEXT NOT NULL,
  "scopeId" TEXT NOT NULL,
  "reply" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PetWorldReceipt_pkey" PRIMARY KEY ("actorId", "requestId"),
  CONSTRAINT "PetWorldReceipt_scope" CHECK ("scopeKind" IN ('owner', 'class'))
);

CREATE UNIQUE INDEX "PetRecognition_id_studentId_key" ON "PetRecognition"("id", "studentId");
CREATE INDEX "PetRecognition_classId_createdAt_id_idx" ON "PetRecognition"("classId", "createdAt", "id");
CREATE INDEX "PetRecognition_studentId_createdAt_id_idx" ON "PetRecognition"("studentId", "createdAt", "id");
CREATE UNIQUE INDEX "PetRecognitionCorrection_recognitionId_key" ON "PetRecognitionCorrection"("recognitionId");
CREATE UNIQUE INDEX "PetPurchase_id_studentId_key" ON "PetPurchase"("id", "studentId");
CREATE UNIQUE INDEX "PetPurchase_studentId_requestId_key" ON "PetPurchase"("studentId", "requestId");
CREATE INDEX "PetPurchase_studentId_createdAt_id_idx" ON "PetPurchase"("studentId", "createdAt", "id");
CREATE UNIQUE INDEX "PetInventoryItem_purchaseId_key" ON "PetInventoryItem"("purchaseId");
CREATE UNIQUE INDEX "PetInventoryItem_purchaseId_studentId_key" ON "PetInventoryItem"("purchaseId", "studentId");
CREATE UNIQUE INDEX "PetWalletEntry_studentId_kind_sourceId_key" ON "PetWalletEntry"("studentId", "kind", "sourceId");
CREATE UNIQUE INDEX "PetWalletEntry_correctionId_key" ON "PetWalletEntry"("correctionId");
CREATE INDEX "PetWalletEntry_studentId_createdAt_id_idx" ON "PetWalletEntry"("studentId", "createdAt", "id");
CREATE INDEX "PetHomeShare_classId_enabled_idx" ON "PetHomeShare"("classId", "enabled");

ALTER TABLE "PetWallet" ADD CONSTRAINT "PetWallet_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetRecognition" ADD CONSTRAINT "PetRecognition_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetRecognition" ADD CONSTRAINT "PetRecognition_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetRecognition" ADD CONSTRAINT "PetRecognition_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetRecognitionCorrection" ADD CONSTRAINT "PetRecognitionCorrection_recognitionId_fkey" FOREIGN KEY ("recognitionId") REFERENCES "PetRecognition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetRecognitionCorrection" ADD CONSTRAINT "PetRecognitionCorrection_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetPurchase" ADD CONSTRAINT "PetPurchase_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetInventoryItem" ADD CONSTRAINT "PetInventoryItem_purchaseId_studentId_fkey" FOREIGN KEY ("purchaseId", "studentId") REFERENCES "PetPurchase"("id", "studentId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetWalletEntry" ADD CONSTRAINT "PetWalletEntry_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "PetWallet"("studentId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetWalletEntry" ADD CONSTRAINT "PetWalletEntry_recognitionId_studentId_fkey" FOREIGN KEY ("recognitionId", "studentId") REFERENCES "PetRecognition"("id", "studentId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetWalletEntry" ADD CONSTRAINT "PetWalletEntry_purchaseId_studentId_fkey" FOREIGN KEY ("purchaseId", "studentId") REFERENCES "PetPurchase"("id", "studentId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetWalletEntry" ADD CONSTRAINT "PetWalletEntry_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "PetRecognitionCorrection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetWorld" ADD CONSTRAINT "PetWorld_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetHomeShare" ADD CONSTRAINT "PetHomeShare_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetHomeShare" ADD CONSTRAINT "PetHomeShare_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ClassroomGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PetWorldReceipt" ADD CONSTRAINT "PetWorldReceipt_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Accounting history and final corrections cannot be silently edited or deleted.
CREATE FUNCTION "RejectPetAccountingMutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Pet accounting history is immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PetWalletEntry_immutable" BEFORE UPDATE OR DELETE ON "PetWalletEntry"
FOR EACH ROW EXECUTE FUNCTION "RejectPetAccountingMutation"();
CREATE TRIGGER "PetPurchase_immutable" BEFORE UPDATE OR DELETE ON "PetPurchase"
FOR EACH ROW EXECUTE FUNCTION "RejectPetAccountingMutation"();
CREATE TRIGGER "PetInventoryItem_immutable" BEFORE UPDATE OR DELETE ON "PetInventoryItem"
FOR EACH ROW EXECUTE FUNCTION "RejectPetAccountingMutation"();

CREATE FUNCTION "ProtectPetRecognition"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Pet recognition accounting is immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."classId", NEW."teacherId", NEW."studentId", NEW."batchId", NEW."requestId",
      NEW."amount", NEW."category", NEW."sessionId", NEW."activityId", NEW."createdAt")
    IS DISTINCT FROM (OLD."id", OLD."classId", OLD."teacherId", OLD."studentId", OLD."batchId", OLD."requestId",
      OLD."amount", OLD."category", OLD."sessionId", OLD."activityId", OLD."createdAt") THEN
    RAISE EXCEPTION 'Pet recognition accounting is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."note" IS DISTINCT FROM OLD."note" AND NEW."note" IS NOT NULL THEN
    RAISE EXCEPTION 'Pet recognition prose may only be removed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PetRecognition_accounting_immutable" BEFORE UPDATE OR DELETE ON "PetRecognition"
FOR EACH ROW EXECUTE FUNCTION "ProtectPetRecognition"();
-- Only private reason prose may be scrubbed; correction identity and accounting are final.
CREATE FUNCTION "ProtectPetRecognitionCorrection"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Pet recognition corrections are final' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."recognitionId", NEW."teacherId", NEW."kind", NEW."createdAt")
    IS DISTINCT FROM (OLD."id", OLD."recognitionId", OLD."teacherId", OLD."kind", OLD."createdAt") THEN
    RAISE EXCEPTION 'Pet recognition corrections are final' USING ERRCODE = '23514';
  END IF;
  IF NEW."reason" IS DISTINCT FROM OLD."reason" AND NEW."reason" IS NOT NULL THEN
    RAISE EXCEPTION 'Pet correction prose may only be removed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PetRecognitionCorrection_accounting_final" BEFORE UPDATE OR DELETE ON "PetRecognitionCorrection"
FOR EACH ROW EXECUTE FUNCTION "ProtectPetRecognitionCorrection"();

-- A positive accounting source has teacher/class/student provenance at issuance time.
-- Later role changes never rewrite a committed award.
CREATE FUNCTION "CheckPetGrantAuthority"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ClassroomGroup" AS school_class
    JOIN "user" AS teacher ON teacher."id" = NEW."teacherId" AND teacher."role" = 'teacher'
    JOIN "user" AS student ON student."id" = NEW."studentId" AND student."role" = 'student'
    JOIN "ClassroomEnrollment" AS enrollment ON enrollment."classId" = school_class."id"
      AND enrollment."studentId" = student."id" AND enrollment."active"
    WHERE school_class."id" = NEW."classId" AND school_class."teacherId" = teacher."id"
      AND school_class."deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Pet grant requires current classroom teacher authority' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PetRecognition_teacher_authority" BEFORE INSERT ON "PetRecognition"
FOR EACH ROW EXECUTE FUNCTION "CheckPetGrantAuthority"();

CREATE FUNCTION "CheckPetCorrectionAuthority"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "PetRecognition" AS recognition
    JOIN "ClassroomGroup" AS school_class ON school_class."id" = recognition."classId"
      AND school_class."teacherId" = recognition."teacherId" AND school_class."deletedAt" IS NULL
    JOIN "user" AS teacher ON teacher."id" = recognition."teacherId" AND teacher."role" = 'teacher'
    WHERE recognition."id" = NEW."recognitionId" AND recognition."teacherId" = NEW."teacherId"
  ) THEN
    RAISE EXCEPTION 'Pet correction requires the original classroom teacher' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PetRecognitionCorrection_teacher_authority" BEFORE INSERT ON "PetRecognitionCorrection"
FOR EACH ROW EXECUTE FUNCTION "CheckPetCorrectionAuthority"();

CREATE FUNCTION "CheckPetEntrySource"() RETURNS trigger AS $$
DECLARE
  source_amount BIGINT;
BEGIN
  IF NEW."kind" = 'teacher_grant' THEN
    SELECT "amount" INTO source_amount FROM "PetRecognition"
      WHERE "id" = NEW."recognitionId" AND "studentId" = NEW."studentId" AND "requestId" = NEW."requestId";
    IF source_amount IS NULL OR NEW."delta" <> source_amount THEN
      RAISE EXCEPTION 'Pet grant entry does not match its recognition' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."kind" = 'purchase' THEN
    SELECT "amount" INTO source_amount FROM "PetPurchase"
      WHERE "id" = NEW."purchaseId" AND "studentId" = NEW."studentId" AND "requestId" = NEW."requestId";
    IF source_amount IS NULL OR NEW."delta" <> -source_amount THEN
      RAISE EXCEPTION 'Pet purchase entry does not match its purchase' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."kind" = 'grant_reversal' THEN
    SELECT recognition."amount" INTO source_amount FROM "PetRecognition" AS recognition
    JOIN "PetRecognitionCorrection" AS correction ON correction."recognitionId" = recognition."id"
      AND correction."id" = NEW."correctionId" AND correction."kind" = 'reversed'
      AND correction."teacherId" = recognition."teacherId"
    WHERE recognition."id" = NEW."recognitionId" AND recognition."studentId" = NEW."studentId";
    IF source_amount IS NULL OR NEW."delta" <> -source_amount THEN
      RAISE EXCEPTION 'Pet reversal entry does not match its correction' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PetWalletEntry_source_matches" BEFORE INSERT ON "PetWalletEntry"
FOR EACH ROW EXECUTE FUNCTION "CheckPetEntrySource"();

-- Check the final transaction state, allowing the balance and entry to be written in either order.
CREATE FUNCTION "CheckPetWalletBalance"() RETURNS trigger AS $$
DECLARE
  wallet_owner TEXT;
  actual_balance BIGINT;
  ledger_balance NUMERIC;
BEGIN
  wallet_owner := NEW."studentId";
  SELECT "balance" INTO actual_balance FROM "PetWallet" WHERE "studentId" = wallet_owner;
  SELECT COALESCE(SUM("delta"), 0) INTO ledger_balance FROM "PetWalletEntry" WHERE "studentId" = wallet_owner;
  IF actual_balance IS DISTINCT FROM ledger_balance THEN
    RAISE EXCEPTION 'Pet wallet and accounting history disagree' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "PetWallet_balanced" AFTER INSERT OR UPDATE ON "PetWallet"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "CheckPetWalletBalance"();
CREATE CONSTRAINT TRIGGER "PetWalletEntry_balanced" AFTER INSERT ON "PetWalletEntry"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "CheckPetWalletBalance"();
