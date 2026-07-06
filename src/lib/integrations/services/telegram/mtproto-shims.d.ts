// Minimal ambient module declarations for `telegram` (gramjs) and
// `flexsearch`. Kept alongside the Telegram integration so `npx tsc --noEmit`
// succeeds even before the packages are installed via `npm install`. Once the
// real packages land these shims stay in place — `skipLibCheck: true` in
// tsconfig.json means TypeScript prefers the actual types when they're
// present.

declare module "telegram" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Api: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class TelegramClient {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(session: any, apiId: number, apiHash: string, options?: any);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    isUserAuthorized(): Promise<boolean>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invoke<T = any>(request: any): Promise<T>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendCode(input: any, phoneNumber: string): Promise<{ phoneCodeHash: string; isCodeViaApp?: boolean }>;
    signInUser(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      auth: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getDialogs(opts?: { limit?: number; offsetDate?: number; archived?: boolean }): Promise<any[]>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getMessages(peer: any, opts?: { limit?: number; offsetId?: number; minId?: number; maxId?: number }): Promise<any[]>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMessage(peer: any, params: { message: string; replyTo?: number }): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getEntity(peer: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getInputEntity(peer: any): Promise<any>;
  }
}

declare module "telegram/sessions" {
  export class StringSession {
    constructor(session?: string);
    save(): string;
  }
}

declare module "telegram/tl" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Api: any;
}

declare module "flexsearch" {
  export interface IndexOptions {
    tokenize?: "strict" | "forward" | "reverse" | "full";
    resolution?: number;
    context?: boolean | { depth?: number; bidirectional?: boolean; resolution?: number };
    optimize?: boolean;
    cache?: boolean | number;
  }

  export interface DocumentDescriptor {
    id: string;
    index: string[] | Array<{ field: string; tokenize?: string }>;
    store?: string[] | boolean;
  }

  export interface DocumentOptions {
    document: DocumentDescriptor;
    tokenize?: "strict" | "forward" | "reverse" | "full";
    optimize?: boolean;
    cache?: boolean | number;
    context?: boolean | { depth?: number; bidirectional?: boolean; resolution?: number };
  }

  export interface SearchResult<T = unknown> {
    field: string;
    result: Array<string | { id: string; doc: T }>;
  }

  export class Document<T = unknown> {
    constructor(options: DocumentOptions);
    add(doc: T): void;
    update(doc: T): void;
    remove(id: string | number): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    search(query: string, opts?: { limit?: number; index?: string | string[]; enrich?: boolean; suggest?: boolean }): SearchResult<T>[] | any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export(fn: (key: string, data: any) => void): Promise<void> | void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    import(key: string, data: any): void;
  }

  export class Index {
    constructor(options?: IndexOptions);
    add(id: string | number, content: string): void;
    update(id: string | number, content: string): void;
    remove(id: string | number): void;
    search(query: string, limit?: number): Array<string | number>;
  }
}
