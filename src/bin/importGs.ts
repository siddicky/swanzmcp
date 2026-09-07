import { importGsSubmissions } from '../importers/gsSubmissions.js';

const USAGE = `Usage: import:gs <submissions.jsonl> [more.jsonl ...] [--mongo-uri <uri>] [--batch-size <n>]

Imports Gray Swan gs-submissions JSONL exports into MongoDB.
File paths are positional (shell-expanded); --mongo-uri overrides MONGODB_URI.
Example: npm run import:gs -- ../ai_red_teaming/arena/gs-scrape.local/hazard-hunt-q3_submissions.jsonl --mongo-uri mongodb://127.0.0.1:27017/greyswan
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const files: string[] = [];
  let mongoUri: string | undefined;
  let batchSize: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mongo-uri') {
      const value = argv[++i];
      if (!value) {
        console.error('--mongo-uri requires a value');
        return 2;
      }
      mongoUri = value;
    } else if (arg === '--batch-size') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        console.error('--batch-size requires a positive number');
        return 2;
      }
      batchSize = value;
    } else if (arg === '-h' || arg === '--help') {
      console.error(USAGE);
      return 0;
    } else {
      files.push(arg);
    }
  }

  try {
    const summary = await importGsSubmissions({ files, mongoUri, batchSize });
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    const { disconnectFromDatabase } = await import('../db/connection.js');
    await disconnectFromDatabase();
  }
}

process.exitCode = await main();
