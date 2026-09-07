// The MIME map moved to src/os/file-handlers.ts (036) so the client Files app
// can resolve a file's type with exactly the same table the server registry
// matches handlers against — one map, no drift. This module stays as the
// server-side import path its three existing callers already use.
export { mimeForPath, baseMime } from "@/os/file-handlers";
