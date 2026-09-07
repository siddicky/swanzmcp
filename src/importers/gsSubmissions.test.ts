import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { appendFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Message, Model, Thread } from '../db/models/index.js';
import { messageController, threadController } from '../db/controllers/index.js';
import { runMongoQueryMessagesTool } from '../tools/mongoQueryMessages.js';
import { runMongoQueryThreadsTool } from '../tools/mongoQueryThreads.js';
import { importGsSubmissions } from './gsSubmissions.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

let mongo: MongoMemoryServer;
let uri: string;

beforeAll(async () => {
  // First run may download the MongoDB binary — hence the 600s hook timeout.
  mongo = await MongoMemoryServer.create();
  uri = mongo.getUri();
  // Connect directly: importing src/db/connection.ts here would bake the
  // default localhost URI into its module-level const before the memory
  // server exists. The CLI spawn (own process) exercises connection.ts.
  await mongoose.connect(uri);
}, 600_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(cmd: string, args: string[], cwd: string): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Extract the JSON payload from a real MCP tool-handler text result. */
function handlerPayload(result: { content: { type: string; text: string }[] }): unknown {
  const text = result.content[0].text;
  return JSON.parse(text.slice(text.indexOf(':') + 1));
}

describe('gs-submissions importer: fixture mapping + idempotent re-run', () => {
  it('maps submissions to model/thread/message documents and re-runs idempotently', async () => {
    const summary = await importGsSubmissions({
      files: [fixture('gs-sample.jsonl')],
      mongoUri: uri,
    });
    expect(summary.modelsUpserted).toBe(2);
    expect(summary.threadsUpserted).toBe(2);
    expect(summary.messagesInserted).toBe(5);
    expect(summary.malformedSkipped).toBe(0);

    // Assert against REAL documents, not the importer's returned counts.
    expect(await Model.countDocuments()).toBe(2);
    expect(await Thread.countDocuments()).toBe(2);
    expect(await Message.countDocuments()).toBe(5);

    const thread = await Thread.findOne({ 'metadata.submissionId': 'gs-fixture-sub-001' });
    expect(thread).not.toBeNull();
    expect(thread!.title).toBe('System Prompt Extraction — gpt-oss-120b');
    expect(thread!.metadata.source).toBe('gs-submissions@6128748');
    expect(thread!.metadata.userId).toBe('gs-submissions');
    expect(thread!.metadata.chatId).toBe('chat-001');
    expect(thread!.metadata.arena).toBe('hazard-hunt-q3');
    expect(thread!.metadata.wave).toBe('wave-2');
    expect(thread!.metadata.behaviorType).toBe('Prompt Extraction');
    expect(thread!.metadata.attackType).toBe('Direct');
    expect(thread!.metadata.status).toBe('success');
    expect(thread!.metadata.detailUrl).toBe('https://app.grayswan.ai/arena/chat/chat-001');
    expect(thread!.challenges).toHaveLength(1);
    expect(thread!.challenges[0]).toMatchObject({
      name: 'System Prompt Extraction',
      description: 'Model reveals its operating instructions when asked directly.',
      category: 'Prompt Extraction',
      severity: 'high',
      status: 'identified',
      notes: 'Direct',
    });
    const model = await Model.findById(thread!.modelId);
    expect(model).not.toBeNull();
    expect(model!.name).toBe('gpt-oss-120b');
    expect(model!.provider).toBe('Gray Swan');

    // threadController populates modelId — prove the reference resolves end to end.
    const populated = await threadController.getThreadById(String(thread!._id));
    expect(populated).not.toBeNull();
    const populatedModel = populated!.modelId as unknown as { name: string; provider: string };
    expect(populatedModel.name).toBe('gpt-oss-120b');
    expect(populatedModel.provider).toBe('Gray Swan');

    const messages = await messageController.getMessagesByThreadId(String(thread!._id));
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages.map((m) => m.metadata.order)).toEqual([0, 1, 2]);
    expect(messages[1].metadata.toolCallCount).toBe(2);
    expect(messages[1].metadata.reasoningBlockCount).toBe(1);
    expect(messages[0].metadata.toolCallCount).toBe(0);

    // failure record maps to low/unresolved with the category fallback.
    const thread2 = await Thread.findOne({ 'metadata.submissionId': 'gs-fixture-sub-002' });
    expect(thread2).not.toBeNull();
    expect(thread2!.challenges[0]).toMatchObject({
      name: 'Data Exfiltration Probe',
      category: 'arena',
      severity: 'low',
      status: 'unresolved',
      notes: 'Indirect',
    });

    // Sparse unique index on metadata.submissionId actually exists on the collection.
    await Thread.syncIndexes();
    const indexes = await Thread.collection.indexes();
    const subIdx = indexes.find((i) => i.name === 'metadata.submissionId_1');
    expect(subIdx).toBeTruthy();
    expect(subIdx!.unique).toBe(true);
    expect(subIdx!.sparse).toBe(true);

    // Idempotent re-run: duplicate submission_id import → counts unchanged, messages REPLACED.
    const oldIds = messages.map((m) => String(m._id));
    const rerun = await importGsSubmissions({
      files: [fixture('gs-sample.jsonl')],
      mongoUri: uri,
    });
    expect(rerun.threadsUpserted).toBe(2);
    expect(await Model.countDocuments()).toBe(2);
    expect(await Thread.countDocuments()).toBe(2);
    expect(await Message.countDocuments()).toBe(5);

    const replaced = await messageController.getMessagesByThreadId(String(thread!._id));
    expect(replaced).toHaveLength(3);
    expect(replaced.map((m) => m.content)).toEqual(messages.map((m) => m.content));
    const newIds = replaced.map((m) => String(m._id));
    expect(new Set([...oldIds, ...newIds]).size).toBe(6);
  });
});

describe('gs-submissions importer: malformed-line tolerance', () => {
  it('warns on malformed lines and continues with the rest of the file', async () => {
    const threadsBefore = await Thread.countDocuments();
    const messagesBefore = await Message.countDocuments();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const summary = await importGsSubmissions({
      files: [fixture('gs-malformed.jsonl')],
      mongoUri: uri,
    });

    expect(summary.malformedSkipped).toBe(2);
    expect(summary.threadsUpserted).toBe(2);
    expect(await Thread.countDocuments()).toBe(threadsBefore + 2);
    expect(await Message.countDocuments()).toBe(messagesBefore + 2);
    expect(await Thread.findOne({ 'metadata.submissionId': 'gs-fixture-mal-002' })).not.toBeNull();
    const warned = errSpy.mock.calls.some((call) =>
      String(call[0]).includes('malformed'),
    );
    expect(warned).toBe(true);
    errSpy.mockRestore();
  });
});

describe('gs-submissions importer: empty-conversation submission', () => {
  it('creates the thread and zero messages for an empty conversation', async () => {
    const threadsBefore = await Thread.countDocuments();
    const messagesBefore = await Message.countDocuments();

    const summary = await importGsSubmissions({
      files: [fixture('gs-empty-conversation.jsonl')],
      mongoUri: uri,
    });

    expect(summary.threadsUpserted).toBe(1);
    expect(summary.messagesInserted).toBe(0);
    expect(await Thread.countDocuments()).toBe(threadsBefore + 1);
    expect(await Message.countDocuments()).toBe(messagesBefore);

    const thread = await Thread.findOne({ 'metadata.submissionId': 'gs-fixture-sub-empty' });
    expect(thread).not.toBeNull();
    const messages = await messageController.getMessagesByThreadId(String(thread!._id));
    expect(messages).toEqual([]);
  });
});

describe('gs-submissions importer: CLI end-to-end', () => {
  it('imports the fixture via the real CLI process and reports a summary', async () => {
    const threadsBefore = await Thread.countDocuments();
    const proc = await runProcess(
      'npx',
      [
        'tsx',
        'src/bin/importGs.ts',
        fixture('gs-sample.jsonl'),
        '--mongo-uri',
        uri,
      ],
      repoRoot,
    );
    expect(proc.code).toBe(0);
    const summary = JSON.parse(proc.stdout);
    expect(summary.threadsUpserted).toBe(2);
    expect(summary.messagesInserted).toBe(5);
    expect(summary.modelsUpserted).toBe(2);
    expect(summary.malformedSkipped).toBe(0);
    // Idempotent: the fixture was already imported in-process, so counts are unchanged.
    expect(await Thread.countDocuments()).toBe(threadsBefore);
    const thread = await Thread.findOne({ 'metadata.submissionId': 'gs-fixture-sub-001' });
    expect(thread).not.toBeNull();
    expect(await Message.countDocuments({ threadId: thread!._id })).toBe(3);
  }, 600_000);

  it('exits 1 with a clean error when zero files resolve', async () => {
    const proc = await runProcess(
      'npx',
      [
        'tsx',
        'src/bin/importGs.ts',
        '/nonexistent/path/does/not/exist.jsonl',
        '--mongo-uri',
        uri,
      ],
      repoRoot,
    );
    expect(proc.code).toBe(1);
    expect(proc.stderr).toContain('no input files resolved');
    expect(proc.stderr).toContain('/nonexistent/path/does/not/exist.jsonl');
  }, 600_000);
});

describe('gs-submissions importer: MCP tool handler surface', () => {
  it('returns the imported submission and its messages through the real handlers', async () => {
    const threadsResult = await runMongoQueryThreadsTool({
      challengeCategory: 'Prompt Extraction',
    });
    const threads = handlerPayload(threadsResult) as Array<Record<string, unknown>>;
    const imported = threads.find(
      (t) => (t.metadata as Record<string, unknown>)?.submissionId === 'gs-fixture-sub-001',
    );
    expect(imported).toBeTruthy();
    expect(imported!.title).toBe('System Prompt Extraction — gpt-oss-120b');
    expect((imported!.challenges as Array<Record<string, unknown>>)[0].severity).toBe('high');

    const messagesResult = await runMongoQueryMessagesTool({
      threadId: String(imported!._id),
    });
    const messages = handlerPayload(messagesResult) as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect((messages[1].metadata as Record<string, unknown>).toolCallCount).toBe(2);

    const bySeverity = await runMongoQueryThreadsTool({ challengeSeverity: 'low' });
    const lowThreads = handlerPayload(bySeverity) as Array<Record<string, unknown>>;
    expect(
      lowThreads.some(
        (t) =>
          (t.metadata as Record<string, unknown>)?.submissionId === 'gs-fixture-sub-002',
      ),
    ).toBe(true);
  });
});

describe('gs-submissions importer: 10k scale', () => {
  it('imports 10,000 synthetic submissions and stays stable on full re-import', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gs-scale-'));
    const file = path.join(dir, 'scale.jsonl');
    const models = ['scale-model-a', 'scale-model-b', 'scale-model-c', 'scale-model-d', 'scale-model-e'];
    const CHUNK = 500;
    let chunk: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const record = {
        submission_id: `scale-sub-${i}`,
        chat_id: `scale-chat-${i}`,
        arena: i % 2 === 0 ? 'hazard-hunt-q3' : 'proving-ground',
        model_name: models[i % models.length],
        behavior_name: `Scale Behavior ${i}`,
        behavior_criteria: 'Synthetic inert scale record.',
        behavior_type: 'Scale',
        attack_type: 'Direct',
        wave: 'wave-scale',
        timestamp_raw: '2026-09-01T00:00:00Z',
        status: i % 2 === 0 ? 'success' : 'failure',
        conversation: [
          { role: 'user', content: `synthetic scale user prompt ${i} (inert)`, order: 0 },
          {
            role: 'assistant',
            content: `synthetic scale assistant response ${i} (inert)`,
            order: 1,
          },
        ],
        detail_url: `https://app.grayswan.ai/arena/chat/scale-chat-${i}`,
        scraped_at: '2026-09-01T00:05:00Z',
      };
      chunk.push(JSON.stringify(record));
      if (chunk.length === CHUNK) {
        appendFileSync(file, chunk.join('\n') + '\n');
        chunk = [];
      }
    }
    if (chunk.length > 0) appendFileSync(file, chunk.join('\n') + '\n');

    const modelsBefore = await Model.countDocuments();
    const threadsBefore = await Thread.countDocuments();
    const messagesBefore = await Message.countDocuments();

    const first = await importGsSubmissions({ files: [file], mongoUri: uri });
    expect(first.threadsUpserted).toBe(10_000);
    expect(first.messagesInserted).toBe(20_000);
    expect(await Model.countDocuments()).toBe(modelsBefore + models.length);
    expect(await Thread.countDocuments()).toBe(threadsBefore + 10_000);
    expect(await Message.countDocuments()).toBe(messagesBefore + 20_000);

    const second = await importGsSubmissions({ files: [file], mongoUri: uri });
    expect(second.threadsUpserted).toBe(10_000);
    expect(await Model.countDocuments()).toBe(modelsBefore + models.length);
    expect(await Thread.countDocuments()).toBe(threadsBefore + 10_000);
    expect(await Message.countDocuments()).toBe(messagesBefore + 20_000);

    rmSync(dir, { recursive: true, force: true });
  }, 600_000);
});

describe('gs-submissions importer: panels-API records (mixed GS+API file)', () => {
  it('imports both record kinds in one pass and re-runs idempotently with zero duplicates', async () => {
    const modelsBefore = await Model.countDocuments();
    const threadsBefore = await Thread.countDocuments();
    const messagesBefore = await Message.countDocuments();

    const first = await importGsSubmissions({
      files: [fixture('mixed-sample.jsonl')],
      mongoUri: uri,
    });
    expect(first.malformedSkipped).toBe(0);
    expect(first.threadsUpserted).toBe(2);
    expect(first.messagesInserted).toBe(5);
    expect(await Model.countDocuments()).toBe(modelsBefore + 2);
    expect(await Thread.countDocuments()).toBe(threadsBefore + 2);
    expect(await Message.countDocuments()).toBe(messagesBefore + 5);

    const apiThread = await Thread.findOne({
      'metadata.submissionId': 'api-fixture-mixed-201',
    });
    expect(apiThread).not.toBeNull();
    expect(apiThread!.title).toBe('data-exfiltration-probe — mixed-model-api');
    expect(apiThread!.metadata.userId).toBe('gs-submissions');
    expect(apiThread!.metadata.chatId).toBe('chat-mixed-201');
    expect(apiThread!.metadata.status).toBe('success');
    expect(apiThread!.metadata.arena).toBeUndefined();
    expect(apiThread!.challenges).toHaveLength(1);
    expect(apiThread!.challenges[0]).toMatchObject({
      name: 'data-exfiltration-probe',
      category: 'arena',
      severity: 'high',
      status: 'identified',
    });
    const apiMessages = await messageController.getMessagesByThreadId(String(apiThread!._id));
    expect(apiMessages).toHaveLength(3);
    expect(apiMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(apiMessages.map((m) => m.metadata.order)).toEqual([0, 1, 2]);
    expect(apiMessages.map((m) => m.content)).toEqual([
      'synthetic mixed api user prompt (inert)',
      'synthetic mixed api assistant response (inert)',
      'synthetic mixed api tool output (inert)',
    ]);

    const gsThread = await Thread.findOne({ 'metadata.submissionId': 'gs-fixture-mixed-001' });
    expect(gsThread).not.toBeNull();
    expect(gsThread!.metadata.source).toBe('gs-submissions@6128748');

    // Idempotent re-run of the MIXED file: exact document counts unchanged.
    const second = await importGsSubmissions({
      files: [fixture('mixed-sample.jsonl')],
      mongoUri: uri,
    });
    expect(second.threadsUpserted).toBe(2);
    expect(second.messagesInserted).toBe(5);
    expect(await Model.countDocuments()).toBe(modelsBefore + 2);
    expect(await Thread.countDocuments()).toBe(threadsBefore + 2);
    expect(await Message.countDocuments()).toBe(messagesBefore + 5);
    const apiMessagesAfter = await messageController.getMessagesByThreadId(String(apiThread!._id));
    expect(apiMessagesAfter).toHaveLength(3);
  });
});

describe('gs-submissions importer: panels-API records (API-only file)', () => {
  it('imports api-shaped records cleanly through the gs document path', async () => {
    const modelsBefore = await Model.countDocuments();
    const threadsBefore = await Thread.countDocuments();
    const messagesBefore = await Message.countDocuments();

    const summary = await importGsSubmissions({
      files: [fixture('api-sample.jsonl')],
      mongoUri: uri,
    });
    expect(summary.malformedSkipped).toBe(0);
    expect(summary.modelsUpserted).toBe(2);
    expect(summary.threadsUpserted).toBe(2);
    expect(summary.messagesInserted).toBe(5);
    expect(await Model.countDocuments()).toBe(modelsBefore + 2);
    expect(await Thread.countDocuments()).toBe(threadsBefore + 2);
    expect(await Message.countDocuments()).toBe(messagesBefore + 5);

    const thread = await Thread.findOne({ 'metadata.submissionId': 'api-fixture-sub-101' });
    expect(thread).not.toBeNull();
    expect(thread!.title).toBe('system-prompt-extraction — api-model-a');
    expect(thread!.metadata.chatId).toBe('chat-api-101');
    expect(thread!.metadata.status).toBe('success');
    const model = await Model.findById(thread!.modelId);
    expect(model).not.toBeNull();
    expect(model!.name).toBe('api-model-a');
    expect(model!.provider).toBe('Gray Swan');
    const messages = await messageController.getMessagesByThreadId(String(thread!._id));
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages[1].metadata.toolCallCount).toBe(0);
    expect(messages[1].metadata.reasoningBlockCount).toBe(0);

    // grading.is_break false maps to the low/unresolved challenge like a gs failure.
    const thread2 = await Thread.findOne({ 'metadata.submissionId': 'api-fixture-sub-102' });
    expect(thread2).not.toBeNull();
    expect(thread2!.metadata.status).toBe('failure');
    expect(thread2!.challenges[0]).toMatchObject({
      name: 'data-exfiltration-probe',
      severity: 'low',
      status: 'unresolved',
    });
  });
});

describe('gs-submissions importer: panels-API malformed-line tolerance', () => {
  it('skips malformed api lines with a warning and completes the import', async () => {
    const threadsBefore = await Thread.countDocuments();
    const messagesBefore = await Message.countDocuments();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const summary = await importGsSubmissions({
      files: [fixture('api-malformed.jsonl')],
      mongoUri: uri,
    });

    expect(summary.malformedSkipped).toBe(2);
    expect(summary.threadsUpserted).toBe(2);
    expect(summary.messagesInserted).toBe(3);
    expect(await Thread.countDocuments()).toBe(threadsBefore + 2);
    expect(await Message.countDocuments()).toBe(messagesBefore + 3);
    expect(await Thread.findOne({ 'metadata.submissionId': 'api-fixture-mal-301' })).not.toBeNull();
    expect(await Thread.findOne({ 'metadata.submissionId': 'api-fixture-mal-303' })).not.toBeNull();
    expect(await Thread.findOne({ 'metadata.submissionId': 'api-fixture-mal-302' })).toBeNull();
    const warned = errSpy.mock.calls.some((call) => String(call[0]).includes('malformed'));
    expect(warned).toBe(true);
    errSpy.mockRestore();
  });
});
