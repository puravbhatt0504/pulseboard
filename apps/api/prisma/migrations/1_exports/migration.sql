-- CreateTable
CREATE TABLE "Export" (
    "jobId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Export_pkey" PRIMARY KEY ("jobId")
);

-- CreateIndex
CREATE INDEX "Export_boardId_idx" ON "Export"("boardId");

-- AddForeignKey
ALTER TABLE "Export" ADD CONSTRAINT "Export_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

