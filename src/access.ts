import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

export type AddResult = "added" | "exists";
export type RemoveResult = "removed" | "env" | "admin" | "missing";
export type GroupRemoveResult = "removed" | "env" | "missing";

export class Access {
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly envUsers: ReadonlySet<number>,
    private readonly admins: ReadonlySet<number>,
    private readonly added: Set<number>,
    private readonly envChats: ReadonlySet<number>,
    private readonly addedChats: Set<number>,
  ) {}

  static async load(
    path: string,
    envUsers: ReadonlySet<number>,
    admins: ReadonlySet<number>,
    envChats: ReadonlySet<number> = new Set(),
  ): Promise<Access> {
    const file = Bun.file(path);
    const added = new Set<number>();
    const addedChats = new Set<number>();
    if (await file.exists()) {
      const data = (await file.json()) as { users?: unknown; chats?: unknown };
      const ids = (value: unknown) => Array.isArray(value) && value.every(Number.isSafeInteger);
      if (!ids(data.users) || (data.chats !== undefined && !ids(data.chats))) {
        throw new Error(`${path} is malformed: expected {"users": [<telegram user id>, ...], "chats": [<chat id>, ...]}`);
      }
      for (const id of data.users as number[]) added.add(id);
      for (const id of (data.chats ?? []) as number[]) addedChats.add(id);
    }
    return new Access(path, envUsers, admins, added, envChats, addedChats);
  }

  isChatAllowed(id: number): boolean {
    return this.envChats.has(id) || this.addedChats.has(id);
  }

  async addChat(id: number): Promise<AddResult> {
    if (this.isChatAllowed(id)) return "exists";
    this.addedChats.add(id);
    await this.persist();
    return "added";
  }

  async removeChat(id: number): Promise<GroupRemoveResult> {
    if (this.addedChats.delete(id)) {
      await this.persist();
      return "removed";
    }
    return this.envChats.has(id) ? "env" : "missing";
  }

  isAdmin(id: number | undefined): boolean {
    return id !== undefined && this.admins.has(id);
  }

  isUser(id: number | undefined): boolean {
    return id !== undefined && (this.admins.has(id) || this.envUsers.has(id) || this.added.has(id));
  }

  list() {
    return {
      admins: [...this.admins],
      env: [...this.envUsers],
      added: [...this.added],
      envChats: [...this.envChats],
      addedChats: [...this.addedChats],
    };
  }

  async add(id: number): Promise<AddResult> {
    if (this.isUser(id)) return "exists";
    this.added.add(id);
    await this.persist();
    return "added";
  }

  async remove(id: number): Promise<RemoveResult> {
    if (this.admins.has(id)) return "admin";
    if (this.added.delete(id)) {
      await this.persist();
      return "removed";
    }
    return this.envUsers.has(id) ? "env" : "missing";
  }

  private persist(): Promise<void> {
    const sorted = (set: Set<number>) => [...set].sort((x, y) => x - y);
    const snapshot = JSON.stringify({ users: sorted(this.added), chats: sorted(this.addedChats) }, null, 2);
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await Bun.write(tmp, `${snapshot}\n`);
      await rename(tmp, this.path);
    });
    return this.writes;
  }
}
