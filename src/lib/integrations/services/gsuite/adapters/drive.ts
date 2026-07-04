import "server-only";
import { ServiceAdapter } from "../../../adapters/base";
import { getService } from "../../../registry";
import { IntegrationConfigError } from "../../../errors";
import type { ServiceDefinition } from "../../../types";
import type { AdapterMethodMeta } from "../../../actions/types";
import { gsuiteFetch, gsuiteFetchBinary, buildUrl } from "../client";
import { DRIVE_SCOPES } from "../manifest";
import { DRIVE_METHOD_DESCRIPTORS, type DriveMethodName } from "./drive-methods";
import { registerAdapter, getAdapterEntry } from "../../../actions/adapter-registry";

// DriveAdapter — Phase 3 read-only surface for Google Drive. Mirrors the
// GmailAdapter pattern: every public method is guarded by `withScope`, hits
// Google via `gsuiteFetch` / `gsuiteFetchBinary`, and returns a JSON-
// serialisable shape so the CopilotKit dispatcher can pass it through
// verbatim.
//
// Write operations (upload, patch, delete, move) are Phase 4 — see
// `client.ts::gsuiteMultipartUpload` stub.

const BASE = "https://www.googleapis.com/drive/v3";
const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KB

// --- Types ---------------------------------------------------------------

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  webViewLink?: string;
  iconLink?: string;
  trashed?: boolean;
}

export interface ListFilesParams {
  q?: string;
  pageSize?: number;
  pageToken?: string;
  orderBy?: string;
  fields?: string;
}
export interface ListFilesResult {
  files: DriveFile[];
  nextPageToken?: string;
}

export interface GetFileParams {
  id: string;
  fields?: string;
}

export interface SearchFilesParams {
  q: string;
  pageSize?: number;
  pageToken?: string;
}

export interface DownloadFileParams {
  id: string;
  maxBytes?: number;
}
export type DownloadFileResult =
  | { contentType: string; base64: string; size: number }
  | { error: "too_large"; size: number; maxBytes: number };

export interface ExportFileParams {
  id: string;
  mimeType: string;
  maxBytes?: number;
}

export interface ListFoldersParams {
  parentId?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface DriveAbout {
  user: { emailAddress?: string; displayName?: string; photoLink?: string };
  storageQuota: { limit?: string; usage?: string; usageInDrive?: string };
}

// --- Helpers -------------------------------------------------------------

const DEFAULT_FIELDS = "id,name,mimeType,size,modifiedTime,parents,webViewLink,iconLink,trashed";
const DEFAULT_LIST_FIELDS = `files(${DEFAULT_FIELDS}),nextPageToken`;

function serviceDef(): ServiceDefinition {
  const svc = getService("gsuite", "drive");
  if (!svc) {
    throw new IntegrationConfigError("Drive service is not registered on the gsuite integration.", {
      integrationId: "gsuite",
    });
  }
  return svc;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buf)).toString("base64");
}

// --- Adapter -------------------------------------------------------------

export class DriveAdapter extends ServiceAdapter {
  constructor() {
    super("gsuite", serviceDef());
  }

  // ---- 3.2.1 listFiles ---------------------------------------------------
  async listFiles(params: ListFilesParams = {}): Promise<ListFilesResult> {
    return this.withScope(DRIVE_SCOPES.readonly, async () => {
      const url = buildUrl(BASE, "/files", {
        q: params.q,
        pageSize: params.pageSize,
        pageToken: params.pageToken,
        orderBy: params.orderBy,
        fields: params.fields ?? DEFAULT_LIST_FIELDS,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const res = await gsuiteFetch<{ files?: DriveFile[]; nextPageToken?: string }>(this, url);
      return { files: res.files ?? [], nextPageToken: res.nextPageToken };
    });
  }

  // ---- 3.2.2 getFile -----------------------------------------------------
  async getFile(params: GetFileParams): Promise<DriveFile> {
    return this.withScope(DRIVE_SCOPES.readonly, async () => {
      const url = buildUrl(BASE, `/files/${encodeURIComponent(params.id)}`, {
        fields: params.fields ?? DEFAULT_FIELDS,
        supportsAllDrives: true,
      });
      return gsuiteFetch<DriveFile>(this, url);
    });
  }

  // ---- 3.2.3 searchFiles -------------------------------------------------
  /**
   * Search Drive with the Drive query syntax. Examples:
   *   `name contains 'invoice'`
   *   `mimeType = 'application/pdf'`
   *   `modifiedTime > '2024-01-01T00:00:00'`
   *   `'root' in parents and trashed = false`
   */
  async searchFiles(params: SearchFilesParams): Promise<ListFilesResult> {
    return this.listFiles({ q: params.q, pageSize: params.pageSize, pageToken: params.pageToken });
  }

  // ---- 3.2.4 downloadFile ------------------------------------------------
  async downloadFile(params: DownloadFileParams): Promise<DownloadFileResult> {
    return this.withScope(DRIVE_SCOPES.readonly, async () => {
      const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
      // Peek metadata first to enforce the size cap without downloading the
      // whole body. Google's DRIVE_FILE.size is returned as a string.
      const meta = await this.getFile({ id: params.id, fields: "size,mimeType" });
      const declaredSize = meta.size ? Number(meta.size) : undefined;
      if (typeof declaredSize === "number" && declaredSize > maxBytes) {
        return { error: "too_large" as const, size: declaredSize, maxBytes };
      }
      const url = buildUrl(BASE, `/files/${encodeURIComponent(params.id)}`, {
        alt: "media",
        supportsAllDrives: true,
      });
      const { contentType, buffer } = await gsuiteFetchBinary(this, url);
      // Extra guard in case metadata omitted `size` and the body ended up larger.
      if (buffer.byteLength > maxBytes) {
        return { error: "too_large" as const, size: buffer.byteLength, maxBytes };
      }
      return {
        contentType,
        base64: arrayBufferToBase64(buffer),
        size: buffer.byteLength,
      };
    });
  }

  // ---- 3.2.5 exportFile --------------------------------------------------
  async exportFile(params: ExportFileParams): Promise<DownloadFileResult> {
    return this.withScope(DRIVE_SCOPES.readonly, async () => {
      const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
      const url = buildUrl(BASE, `/files/${encodeURIComponent(params.id)}/export`, {
        mimeType: params.mimeType,
      });
      const { contentType, buffer } = await gsuiteFetchBinary(this, url);
      if (buffer.byteLength > maxBytes) {
        return { error: "too_large" as const, size: buffer.byteLength, maxBytes };
      }
      return {
        contentType,
        base64: arrayBufferToBase64(buffer),
        size: buffer.byteLength,
      };
    });
  }

  // ---- 3.2.6 listFolders -------------------------------------------------
  async listFolders(params: ListFoldersParams = {}): Promise<ListFilesResult> {
    const parts = ["mimeType = 'application/vnd.google-apps.folder'", "trashed = false"];
    if (params.parentId) parts.push(`'${params.parentId.replace(/'/g, "\\'")}' in parents`);
    const q = parts.join(" and ");
    return this.listFiles({ q, pageSize: params.pageSize, pageToken: params.pageToken });
  }

  // ---- 3.2.7 getAbout ----------------------------------------------------
  async getAbout(): Promise<DriveAbout> {
    return this.withScope(DRIVE_SCOPES.readonly, async () => {
      const url = buildUrl(BASE, "/about", { fields: "user,storageQuota" });
      return gsuiteFetch<DriveAbout>(this, url);
    });
  }
}

// --- Method metadata -----------------------------------------------------

const DRIVE_INVOKERS: Record<
  DriveMethodName,
  (adapter: DriveAdapter, args: Record<string, unknown>) => Promise<unknown>
> = {
  listFiles: (adapter, args) =>
    adapter.listFiles({
      q: args.q as string | undefined,
      pageSize: args.pageSize as number | undefined,
      pageToken: args.pageToken as string | undefined,
      orderBy: args.orderBy as string | undefined,
      fields: args.fields as string | undefined,
    }),
  getFile: (adapter, args) =>
    adapter.getFile({
      id: String(args.id),
      fields: args.fields as string | undefined,
    }),
  searchFiles: (adapter, args) =>
    adapter.searchFiles({
      q: String(args.q),
      pageSize: args.pageSize as number | undefined,
      pageToken: args.pageToken as string | undefined,
    }),
  downloadFile: (adapter, args) =>
    adapter.downloadFile({
      id: String(args.id),
      maxBytes: args.maxBytes as number | undefined,
    }),
  exportFile: (adapter, args) =>
    adapter.exportFile({
      id: String(args.id),
      mimeType: String(args.mimeType),
      maxBytes: args.maxBytes as number | undefined,
    }),
  listFolders: (adapter, args) =>
    adapter.listFolders({
      parentId: args.parentId as string | undefined,
      pageSize: args.pageSize as number | undefined,
      pageToken: args.pageToken as string | undefined,
    }),
  getAbout: (adapter) => adapter.getAbout(),
};

export const DRIVE_METHODS: readonly AdapterMethodMeta<DriveAdapter>[] =
  DRIVE_METHOD_DESCRIPTORS.map((d) => ({
    method: d.method,
    scope: d.scope,
    description: d.description,
    parameters: d.parameters,
    invoke: DRIVE_INVOKERS[d.method],
  }));

// Re-export for parity with gmail.ts.
export type { DriveMethodName } from "./drive-methods";

// --- Registration --------------------------------------------------------
if (!getAdapterEntry("gsuite", "drive")) {
  registerAdapter("gsuite", "drive", {
    createAdapter: () => new DriveAdapter(),
    methods: DRIVE_METHODS,
  });
}
