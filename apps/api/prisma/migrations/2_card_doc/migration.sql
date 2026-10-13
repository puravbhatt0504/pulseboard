CREATE TABLE "CardDoc" (
    "cardId" TEXT NOT NULL,
    "state" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CardDoc_pkey" PRIMARY KEY ("cardId")
);

ALTER TABLE "CardDoc" ADD CONSTRAINT "CardDoc_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;
