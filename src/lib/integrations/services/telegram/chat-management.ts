import "server-only";
import { IntegrationError } from "../../errors";
import { withClient, type MtprotoClient } from "./mtproto-client";
import { updateCachedChat } from "./user-cache";

// Per-chat state operations for the user (MTProto) service. Every function
// takes a chat identifier (numeric id, @username, or "me") and reflects the
// change both server-side (via gramjs `invoke(...)`) and locally in the
// chat cache so the UI updates instantly without waiting for a re-fetch.
//
// gramjs exposes the wire types under `Api` — we grab the module lazily so a
// missing gramjs install produces the same friendly error path used by the
// rest of the MTProto surface.

interface GramjsApiModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Api: any;
}

async function loadApi(): Promise<GramjsApiModule["Api"]> {
  try {
    const mod = (await import(/* turbopackIgnore: true */ "telegram")) as GramjsApiModule;
    return mod.Api;
  } catch (err) {
    throw new IntegrationError(
      "telegram_mtproto_missing",
      "gramjs not installed. Run `npm install telegram` and restart.",
      { integrationId: "telegram", cause: err },
    );
  }
}

/**
 * Mute a chat. `muteUntilEpoch` semantics follow MTProto: 0 unmutes, values in
 * the past also unmute (server clamps to now), values in the future mute
 * until that time. Passing MAX_INT32 mutes indefinitely.
 */
export async function setMuteState(input: {
  chatId: string;
  muteUntilEpoch: number;
}): Promise<{ chatId: string; muted: boolean; muteUntil: number }> {
  const Api = await loadApi();
  await withClient(async (client: MtprotoClient) => {
    const peer = await client.getInputEntity(input.chatId);
    await client.invoke(
      new Api.account.UpdateNotifySettings({
        peer: new Api.InputNotifyPeer({ peer }),
        settings: new Api.InputPeerNotifySettings({
          muteUntil: input.muteUntilEpoch,
          silent: false,
          showPreviews: true,
        }),
      }),
    );
  });
  const muted = input.muteUntilEpoch > Math.floor(Date.now() / 1000);
  await updateCachedChat(input.chatId, { muted });
  return { chatId: input.chatId, muted, muteUntil: input.muteUntilEpoch };
}

/** Move a chat between the main and archive folder. `archive: true` archives. */
export async function setArchiveState(input: {
  chatId: string;
  archive: boolean;
}): Promise<{ chatId: string; archived: boolean }> {
  const Api = await loadApi();
  await withClient(async (client: MtprotoClient) => {
    const peer = await client.getInputEntity(input.chatId);
    // Folder 1 = Archive, 0 = Main.
    await client.invoke(
      new Api.folders.EditPeerFolders({
        folderPeers: [
          new Api.InputFolderPeer({
            peer,
            folderId: input.archive ? 1 : 0,
          }),
        ],
      }),
    );
  });
  await updateCachedChat(input.chatId, { archived: input.archive });
  return { chatId: input.chatId, archived: input.archive };
}

/** Pin or unpin a chat in the main dialog list. */
export async function setPinState(input: {
  chatId: string;
  pinned: boolean;
}): Promise<{ chatId: string; pinned: boolean }> {
  const Api = await loadApi();
  await withClient(async (client: MtprotoClient) => {
    const peer = await client.getInputEntity(input.chatId);
    await client.invoke(
      new Api.messages.ToggleDialogPin({
        peer: new Api.InputDialogPeer({ peer }),
        pinned: input.pinned,
      }),
    );
  });
  await updateCachedChat(input.chatId, { pinned: input.pinned });
  return { chatId: input.chatId, pinned: input.pinned };
}
