import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import mongoose from 'mongoose';
import { Model } from '../db/models/model.js';
import { Thread, IThread } from '../db/models/thread.js';
import { Message } from '../db/models/message.js';

export const GS_SOURCE = 'gs-submissions@6128748';
const GS_USER_ID = 'gs-submissions';
const DEFAULT_BATCH_SIZE = 500;

type GsMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface GsConversationEntry {
  role: string;
  content?: string;
  tool_calls?: unknown[];
  reasoning?: unknown[];
  order?: number;
}

// Shape of one gs-submissions JSONL line (verified against src/models.py @ pin).
export interface GsSubmissionRecord {
  submission_id: string;
  chat_id?: string;
  arena?: string;
  model_name?: string;
  behavior_name?: string;
  behavior_criteria?: string;
  behavior_type?: string;
  attack_type?: string;
  wave?: string;
  timestamp_raw?: string;
  status?: string;
  conversation?: GsConversationEntry[];
  detail_url?: string;
  scraped_at?: string;
}

export interface GsImportSummary {
  files: number;
  records: number;
  modelsUpserted: number;
  threadsUpserted: number;
  messagesDeleted: number;
  messagesInserted: number;
  malformedSkipped: number;
}

export interface ImportGsSubmissionsOptions {
  files: string[];
  mongoUri?: string;
  batchSize?: number;
}

function isRecord(value: unknown): value is GsSubmissionRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as GsSubmissionRecord).submission_id === 'string' &&
    (value as GsSubmissionRecord).submission_id !== ''
  );
}

async function upsertModel(
  record: GsSubmissionRecord,
  cache: Map<string, mongoose.Types.ObjectId>,
  summary: GsImportSummary
): Promise<mongoose.Types.ObjectId> {
  const name = record.model_name;
  if (!name) {
    throw new Error(`record ${record.submission_id} has no model_name`);
  }
  const cached = cache.get(name);
  if (cached) return cached;
  const model = await Model.findOneAndUpdate(
    { name, provider: 'Gray Swan' },
    { $setOnInsert: { name, provider: 'Gray Swan', version: 'unknown', capabilities: [] } },
    { upsert: true, new: true }
  );
  if (!model) {
    throw new Error(`model upsert failed for ${name}`);
  }
  cache.set(name, model._id as mongoose.Types.ObjectId);
  summary.modelsUpserted += 1;
  return model._id as mongoose.Types.ObjectId;
}

async function upsertThread(
  record: GsSubmissionRecord,
  modelId: mongoose.Types.ObjectId
): Promise<IThread> {
  const success = record.status === 'success';
  const update: mongoose.UpdateQuery<IThread> = {
    $set: {
      title: `${record.behavior_name ?? ''} — ${record.model_name ?? ''}`,
      modelId,
      metadata: {
        userId: GS_USER_ID,
        submissionId: record.submission_id,
        chatId: record.chat_id,
        arena: record.arena,
        wave: record.wave,
        behaviorType: record.behavior_type,
        attackType: record.attack_type,
        detailUrl: record.detail_url,
        scrapedAt: record.scraped_at,
        status: record.status,
        source: GS_SOURCE,
      },
      challenges: [
        {
          name: record.behavior_name ?? '',
          description: record.behavior_criteria ?? '',
          category: record.behavior_type || 'arena',
          severity: success ? 'high' : 'low',
          status: success ? 'identified' : 'unresolved',
          notes: record.attack_type,
        },
      ],
    },
  };
  const thread = await Thread.findOneAndUpdate(
    { 'metadata.submissionId': record.submission_id },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (!thread) {
    throw new Error(`thread upsert failed for submission ${record.submission_id}`);
  }
  return thread;
}

async function replaceMessages(
  threadId: mongoose.Types.ObjectId,
  conversation: GsConversationEntry[],
  batchSize: number,
  summary: GsImportSummary
): Promise<void> {
  const deleted = await Message.deleteMany({ threadId });
  summary.messagesDeleted += deleted.deletedCount ?? 0;
  const docs = conversation.map((entry, index) => ({
    threadId,
    role: (entry.role ?? 'system') as GsMessageRole,
    content: entry.content ?? '',
    metadata: {
      order: entry.order ?? index,
      toolCallCount: Array.isArray(entry.tool_calls) ? entry.tool_calls.length : 0,
      reasoningBlockCount: Array.isArray(entry.reasoning) ? entry.reasoning.length : 0,
    },
  }));
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    await Message.insertMany(batch, { ordered: false });
    summary.messagesInserted += batch.length;
  }
}

export async function importGsSubmissions(
  options: ImportGsSubmissionsOptions
): Promise<GsImportSummary> {
  const batchSize =
    options.batchSize && options.batchSize > 0 ? options.batchSize : DEFAULT_BATCH_SIZE;
  const resolved = options.files.filter((file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
  if (resolved.length === 0) {
    const listed = options.files.length > 0 ? options.files.join(', ') : '(none provided)';
    throw new Error(`no input files resolved among: ${listed}`);
  }

  if (options.mongoUri) {
    process.env.MONGODB_URI = options.mongoUri;
  }
  const { connectToDatabase } = await import('../db/connection.js');
  if (mongoose.connection.readyState !== 1) {
    await connectToDatabase();
  }
  await Thread.syncIndexes();

  const summary: GsImportSummary = {
    files: 0,
    records: 0,
    modelsUpserted: 0,
    threadsUpserted: 0,
    messagesDeleted: 0,
    messagesInserted: 0,
    malformedSkipped: 0,
  };
  const modelIds = new Map<string, mongoose.Types.ObjectId>();

  for (const file of resolved) {
    const rl = createInterface({
      input: createReadStream(file, 'utf8'),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: GsSubmissionRecord;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!isRecord(parsed)) {
          throw new Error('line has no submission_id');
        }
        record = parsed;
      } catch (error) {
        summary.malformedSkipped += 1;
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[import:gs] skipping malformed line in ${file}: ${reason}`);
        continue;
      }
      const modelId = await upsertModel(record, modelIds, summary);
      const thread = await upsertThread(record, modelId);
      summary.threadsUpserted += 1;
      await replaceMessages(
        thread._id as mongoose.Types.ObjectId,
        record.conversation ?? [],
        batchSize,
        summary
      );
      summary.records += 1;
    }
    summary.files += 1;
  }
  return summary;
}
