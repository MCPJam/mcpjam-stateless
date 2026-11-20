// In-memory stand-ins for a Durable Object namespace and its storage that
// run the real DO classes, so tests exercise src/runs.ts end to end without
// workerd. Values round-trip through structuredClone, as DO storage does.

export class FakeStorage {
  private data = new Map<string, unknown>();
  alarm: number | null = null;

  async get(key: string): Promise<unknown> {
    return this.data.has(key) ? structuredClone(this.data.get(key)) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
  async setAlarm(time: number | Date): Promise<void> {
    this.alarm = typeof time === "number" ? time : time.getTime();
  }
  get size(): number {
    return this.data.size;
  }
}

interface DurableObjectLike {
  fetch(request: Request): Promise<Response>;
  alarm?(): Promise<void>;
}

export function fakeNamespace<T extends DurableObjectLike>(make: (state: DurableObjectState) => T) {
  const objects = new Map<string, { instance: T; storage: FakeStorage }>();
  const objectFor = (name: string) => {
    let object = objects.get(name);
    if (!object) {
      const storage = new FakeStorage();
      object = { storage, instance: make({ storage } as unknown as DurableObjectState) };
      objects.set(name, object);
    }
    return object;
  };
  const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { name: string }) => ({
      fetch: (input: RequestInfo, init?: RequestInit) => objectFor(id.name).instance.fetch(new Request(input, init)),
    }),
  };
  return { namespace: namespace as unknown as DurableObjectNamespace, objects, objectFor };
}
