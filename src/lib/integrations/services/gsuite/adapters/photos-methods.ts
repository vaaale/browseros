// Framework-free method metadata for PhotosAdapter. Split out of photos.ts
// (which is `server-only`) so the CLIENT dispatcher can walk this list to
// register CopilotKit actions without pulling in Node/Google APIs.

import { PHOTOS_SCOPES } from "../manifest";
import type { AdapterMethodParameter } from "../../../actions/types";

export type PhotosMethodName =
  | "albums_list"
  | "albums_get"
  | "media_items_list"
  | "media_items_get"
  | "media_items_search";

export interface PhotosMethodDescriptor {
  method: PhotosMethodName;
  scope: string;
  description: string;
  parameters: AdapterMethodParameter[];
}

export const PHOTOS_METHOD_DESCRIPTORS: readonly PhotosMethodDescriptor[] = [
  {
    method: "albums_list",
    scope: PHOTOS_SCOPES.readonly,
    description:
      "List the authenticated user's Google Photos albums. Returns id, title, productUrl, mediaItemsCount, coverPhotoBaseUrl per album.",
    parameters: [
      { name: "pageSize", type: "number", description: "Max albums per page (default 20, max 50).", required: false },
      { name: "pageToken", type: "string", description: "Next-page token from a previous call.", required: false },
    ],
  },
  {
    method: "albums_get",
    scope: PHOTOS_SCOPES.readonly,
    description: "Fetch a single Google Photos album by its id.",
    parameters: [
      { name: "id", type: "string", description: "The album id.", required: true },
    ],
  },
  {
    method: "media_items_list",
    scope: PHOTOS_SCOPES.readonly,
    description:
      "List media items from the user's Google Photos library, optionally restricted to a specific album. Returns id, filename, mimeType, baseUrl, mediaMetadata per item. baseUrl expires in ~60 minutes; append '=w2048-h1024' etc. for sizing.",
    parameters: [
      { name: "albumId", type: "string", description: "Restrict to items in this album.", required: false },
      { name: "pageSize", type: "number", description: "Max items per page (default 25, max 100).", required: false },
      { name: "pageToken", type: "string", description: "Next-page token from a previous call.", required: false },
    ],
  },
  {
    method: "media_items_get",
    scope: PHOTOS_SCOPES.readonly,
    description: "Fetch a single media item by its id. Returns full metadata including baseUrl, mimeType, filename, and mediaMetadata.",
    parameters: [
      { name: "id", type: "string", description: "The media item id.", required: true },
    ],
  },
  {
    method: "media_items_search",
    scope: PHOTOS_SCOPES.readonly,
    description:
      "Search media items with optional filters. Supports album restriction, media type (PHOTO / VIDEO), date range, and content categories such as PEOPLE, SELFIES, ANIMALS, FOOD, TRAVEL, LANDSCAPES, CITYSCAPES, BIRTHDAYS, SPORTS, PETS. albumId and date/content filters are mutually exclusive per the Google Photos API.",
    parameters: [
      { name: "albumId", type: "string", description: "Restrict to items in this album (mutually exclusive with date/content filters).", required: false },
      { name: "pageSize", type: "number", description: "Max items per page (default 25, max 100).", required: false },
      { name: "pageToken", type: "string", description: "Next-page token.", required: false },
      { name: "mediaType", type: "string", description: "Filter by type: 'PHOTO', 'VIDEO', or 'ALL_MEDIA'.", required: false },
      { name: "includedContentCategories", type: "string[]", description: "Content categories to include, e.g. ['PEOPLE','SELFIES'].", required: false },
      { name: "excludedContentCategories", type: "string[]", description: "Content categories to exclude.", required: false },
      { name: "dateRangeStart", type: "string", description: "Inclusive start of date range as YYYY-MM-DD.", required: false },
      { name: "dateRangeEnd", type: "string", description: "Inclusive end of date range as YYYY-MM-DD.", required: false },
    ],
  },
];
