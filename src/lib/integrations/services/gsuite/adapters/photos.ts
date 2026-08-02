import "server-only";
import { ServiceAdapter } from "../../../adapters/base";
import { getService } from "../../../registry";
import { IntegrationConfigError } from "../../../errors";
import type { ServiceDefinition } from "../../../types";
import type { AdapterMethodMeta } from "../../../actions/types";
import { gsuiteFetch, buildUrl } from "../client";
import { PHOTOS_SCOPES } from "../manifest";
import { PHOTOS_METHOD_DESCRIPTORS, type PhotosMethodName } from "./photos-methods";
import { registerAdapter, getAdapterEntry } from "../../../actions/adapter-registry";

const BASE = "https://photoslibrary.googleapis.com/v1";

// --- Types ---------------------------------------------------------------

export interface Album {
  id: string;
  title: string;
  productUrl: string;
  isWriteable?: boolean;
  mediaItemsCount?: string;
  coverPhotoBaseUrl?: string;
  coverPhotoMediaItemId?: string;
}

export interface MediaMetadata {
  creationTime?: string;
  width?: string;
  height?: string;
  photo?: {
    cameraMake?: string;
    cameraModel?: string;
    focalLength?: number;
    apertureFNumber?: number;
    isoEquivalent?: number;
    exposureTime?: string;
  };
  video?: {
    cameraMake?: string;
    cameraModel?: string;
    fps?: number;
    status?: string;
  };
}

export interface MediaItem {
  id: string;
  description?: string;
  productUrl: string;
  baseUrl: string;
  mimeType: string;
  mediaMetadata?: MediaMetadata;
  filename: string;
}

export interface ListAlbumsParams {
  pageSize?: number;
  pageToken?: string;
}

export interface ListAlbumsResult {
  albums: Album[];
  nextPageToken?: string;
}

export interface ListMediaItemsParams {
  albumId?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface ListMediaItemsResult {
  mediaItems: MediaItem[];
  nextPageToken?: string;
}

export interface SearchMediaItemsParams {
  albumId?: string;
  pageSize?: number;
  pageToken?: string;
  mediaType?: string;
  includedContentCategories?: string[];
  excludedContentCategories?: string[];
  dateRangeStart?: string;
  dateRangeEnd?: string;
}

// --- Helpers -------------------------------------------------------------

function serviceDef(): ServiceDefinition {
  const svc = getService("gsuite", "photos");
  if (!svc) {
    throw new IntegrationConfigError("Photos service is not registered on the gsuite integration.", {
      integrationId: "gsuite",
    });
  }
  return svc;
}

// Parse "YYYY-MM-DD" into a Google DateObject { year, month, day }.
function parseDate(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { year: y, month: m, day: d };
}

// --- Adapter -------------------------------------------------------------

export class PhotosAdapter extends ServiceAdapter {
  constructor() {
    super("gsuite", serviceDef());
  }

  async listAlbums(params: ListAlbumsParams = {}): Promise<ListAlbumsResult> {
    return this.withScope(PHOTOS_SCOPES.readonly, async () => {
      const url = buildUrl(BASE, "/albums", {
        pageSize: params.pageSize ?? 20,
        pageToken: params.pageToken,
        excludeNonAppCreatedData: false,
      });
      const res = await gsuiteFetch<{ albums?: Album[]; nextPageToken?: string }>(this, url);
      return { albums: res.albums ?? [], nextPageToken: res.nextPageToken };
    });
  }

  async getAlbum(id: string): Promise<Album> {
    return this.withScope(PHOTOS_SCOPES.readonly, async () => {
      return gsuiteFetch<Album>(this, `${BASE}/albums/${encodeURIComponent(id)}`);
    });
  }

  async listMediaItems(params: ListMediaItemsParams = {}): Promise<ListMediaItemsResult> {
    // The Photos API only supports albumId filtering via the search endpoint.
    if (params.albumId) {
      return this.searchMediaItems({
        albumId: params.albumId,
        pageSize: params.pageSize,
        pageToken: params.pageToken,
      });
    }
    return this.withScope(PHOTOS_SCOPES.readonly, async () => {
      const url = buildUrl(BASE, "/mediaItems", {
        pageSize: params.pageSize ?? 25,
        pageToken: params.pageToken,
      });
      const res = await gsuiteFetch<{ mediaItems?: MediaItem[]; nextPageToken?: string }>(this, url);
      return { mediaItems: res.mediaItems ?? [], nextPageToken: res.nextPageToken };
    });
  }

  async getMediaItem(id: string): Promise<MediaItem> {
    return this.withScope(PHOTOS_SCOPES.readonly, async () => {
      return gsuiteFetch<MediaItem>(this, `${BASE}/mediaItems/${encodeURIComponent(id)}`);
    });
  }

  async searchMediaItems(params: SearchMediaItemsParams): Promise<ListMediaItemsResult> {
    return this.withScope(PHOTOS_SCOPES.readonly, async () => {
      const body: Record<string, unknown> = {
        pageSize: params.pageSize ?? 25,
      };
      if (params.pageToken) body.pageToken = params.pageToken;
      if (params.albumId) {
        body.albumId = params.albumId;
      } else {
        // Filters are mutually exclusive with albumId per the Photos API contract.
        const filters: Record<string, unknown> = {};

        if (params.mediaType && params.mediaType !== "ALL_MEDIA") {
          filters.mediaTypeFilter = { mediaTypes: [params.mediaType] };
        }

        if (params.includedContentCategories?.length || params.excludedContentCategories?.length) {
          filters.contentFilter = {
            ...(params.includedContentCategories?.length
              ? { includedContentCategories: params.includedContentCategories }
              : {}),
            ...(params.excludedContentCategories?.length
              ? { excludedContentCategories: params.excludedContentCategories }
              : {}),
          };
        }

        if (params.dateRangeStart || params.dateRangeEnd) {
          const range: Record<string, unknown> = {};
          if (params.dateRangeStart) range.startDate = parseDate(params.dateRangeStart);
          if (params.dateRangeEnd) range.endDate = parseDate(params.dateRangeEnd);
          filters.dateFilter = { ranges: [range] };
        }

        if (Object.keys(filters).length > 0) body.filters = filters;
      }

      const res = await gsuiteFetch<{ mediaItems?: MediaItem[]; nextPageToken?: string }>(this, `${BASE}/mediaItems:search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { mediaItems: res.mediaItems ?? [], nextPageToken: res.nextPageToken };
    });
  }
}

// --- Method invokers -----------------------------------------------------

const PHOTOS_INVOKERS: Record<
  PhotosMethodName,
  (adapter: PhotosAdapter, args: Record<string, unknown>) => Promise<unknown>
> = {
  albums_list: (adapter, args) =>
    adapter.listAlbums({
      pageSize: args.pageSize as number | undefined,
      pageToken: args.pageToken as string | undefined,
    }),
  albums_get: (adapter, args) =>
    adapter.getAlbum(String(args.id)),
  media_items_list: (adapter, args) =>
    adapter.listMediaItems({
      albumId: args.albumId as string | undefined,
      pageSize: args.pageSize as number | undefined,
      pageToken: args.pageToken as string | undefined,
    }),
  media_items_get: (adapter, args) =>
    adapter.getMediaItem(String(args.id)),
  media_items_search: (adapter, args) =>
    adapter.searchMediaItems({
      albumId: args.albumId as string | undefined,
      pageSize: args.pageSize as number | undefined,
      pageToken: args.pageToken as string | undefined,
      mediaType: args.mediaType as string | undefined,
      includedContentCategories: args.includedContentCategories as string[] | undefined,
      excludedContentCategories: args.excludedContentCategories as string[] | undefined,
      dateRangeStart: args.dateRangeStart as string | undefined,
      dateRangeEnd: args.dateRangeEnd as string | undefined,
    }),
};

export const PHOTOS_METHODS: readonly AdapterMethodMeta<PhotosAdapter>[] =
  PHOTOS_METHOD_DESCRIPTORS.map((d) => ({
    method: d.method,
    scope: d.scope,
    description: d.description,
    parameters: d.parameters,
    invoke: PHOTOS_INVOKERS[d.method],
  }));

export type { PhotosMethodName } from "./photos-methods";

// --- Registration --------------------------------------------------------

if (!getAdapterEntry("gsuite", "photos")) {
  registerAdapter("gsuite", "photos", {
    createAdapter: () => new PhotosAdapter(),
    methods: PHOTOS_METHODS,
  });
}
