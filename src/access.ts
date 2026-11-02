import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

export type AddResult = "added" | "exists";
export type RemoveResult = "removed" | "env" | "admin" | "missing";

export class Access {
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly envUsers: ReadonlySet<number>,
    private readonly admins: ReadonlySet<number>,
    private readonly added: Set<number>,
  ) {}

  static async load(path: string, envUsers: ReadonlySet<number>, admins: ReadonlySet<number>): Promise<Access> {
    const file = Bun.file(path);
    const added = new Set<number>();
    if (await file.exists()) {
      const data = (await file.json()) as { users?: unknown };
      if (!Array.isArray(data.users) || !data.users.every(Number.isSafeInteger)) {
        throw new Error(`${path} is malformed: expected {"users": [<telegram user id>, ...]}`);
      }
      for (const id of data.users as number[]) added.add(id);
    }
    return new Access(path, envUsers, admins, added);
  }

  isAdmin(id: number | undefined): boolean {
    return id !== undefined && this.admins.has(id);
  }

  isUser(id: number | undefined): boolean {
    return id !== undefined && (this.admins.has(id) || this.envUsers.has(id) || this.added.has(id));
  }

  list() {
    return { admins: [...this.admins], env: [...this.envUsers], added: [...this.added] };
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
    const snapshot = JSON.stringify({ users: [...this.added].sort((a, b) => a - b) }, null, 2);
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await Bun.write(tmp, `${snapshot}\n`);
      await rename(tmp, this.path);
    });
    return this.writes;
  }
}
