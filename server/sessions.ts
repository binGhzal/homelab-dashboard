import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Identity } from "./access.js";
export const token = () => randomBytes(32).toString("base64url");
export function matches(a: unknown, b: string): boolean {
  return (
    typeof a === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export interface AuthSession {
  identity: Identity;
  accessToken: string;
  tokenExpiresAt: number;
  csrf: string;
  expiresAt: number;
  checkedAt: number;
}
export interface LoginAttempt {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}
export class ExpiringStore<T extends { expiresAt: number }> {
  private values = new Map<string, T>();
  constructor(
    private readonly maxSize = 1000,
    private readonly clock = Date.now,
  ) {}
  prune(): void {
    for (const [id, item] of this.values)
      if (item.expiresAt <= this.clock()) this.values.delete(id);
  }
  set(item: T): string {
    this.prune();
    if (this.values.size >= this.maxSize)
      throw new Error("Session capacity reached");
    const id = token();
    this.values.set(id, item);
    return id;
  }
  get(id: string | undefined): T | undefined {
    if (!id) return;
    const item = this.values.get(id);
    if (item && item.expiresAt <= this.clock()) {
      this.values.delete(id);
      return;
    }
    return item;
  }
  take(id: string | undefined): T | undefined {
    const item = this.get(id);
    if (id) this.values.delete(id);
    return item;
  }
  delete(id: string): void {
    this.values.delete(id);
  }
}
