import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface MessageRecord {
  role: "user" | "assistant";
  content: any;
  timestamp: string;
}

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  messages: MessageRecord[];
  createdAt: string;
  updatedAt: string;
}

export function createSessionStore(baseDir?: string) {
  const dir = baseDir || path.join(os.homedir(), ".opencode-acp", "sessions");

  function filePath(id: string): string {
    return path.join(dir, `${id}.json`);
  }

  return {
    async save(record: SessionRecord): Promise<void> {
      await fs.mkdir(dir, { recursive: true });
      record.updatedAt = new Date().toISOString();
      await fs.writeFile(filePath(record.sessionId), JSON.stringify(record, null, 2), "utf-8");
    },

    async load(sessionId: string): Promise<SessionRecord | null> {
      try {
        const data = await fs.readFile(filePath(sessionId), "utf-8");
        return JSON.parse(data);
      } catch {
        return null;
      }
    },

    async list(): Promise<SessionRecord[]> {
      await fs.mkdir(dir, { recursive: true });
      const files = await fs.readdir(dir);
      const records: SessionRecord[] = [];
      for (const f of files) {
        if (f.endsWith(".json")) {
          try {
            const data = await fs.readFile(path.join(dir, f), "utf-8");
            records.push(JSON.parse(data));
          } catch {}
        }
      }
      return records.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    },

    async delete(sessionId: string): Promise<void> {
      await fs.rm(filePath(sessionId), { force: true });
    },

    async appendMessage(sessionId: string, msg: MessageRecord): Promise<void> {
      const record = await this.load(sessionId);
      if (record) {
        record.messages.push(msg);
        await this.save(record);
      }
    },
  };
}