/**
 * MoQT control message type re-exports from @moqtap/codec.
 *
 * Draft-07 uses the generic MoqtMessage types (camelCase).
 * Draft-14 uses Draft14Message types (snake_case).
 */

// ─── Draft-07 message types ────────────────────────────────────────────
export type {
  MoqtMessage,
  MoqtMessageType,
  ClientSetup,
  ServerSetup,
  Subscribe,
  SubscribeOk,
  SubscribeError,
  SubscribeDone,
  SubscribeUpdate,
  Unsubscribe,
  Announce,
  AnnounceOk,
  AnnounceError,
  AnnounceCancel,
  Unannounce,
  GoAway,
  TrackStatusRequest,
  TrackStatus,
  Fetch,
  FetchOk,
  FetchError,
  FetchCancel,
  SubscribeAnnounces,
  SubscribeAnnouncesOk,
  SubscribeAnnouncesError,
  UnsubscribeAnnounces,
  MaxSubscribeId,
  FilterType,
  GroupOrderValue,
} from '@moqtap/codec';

// ─── Draft-14 message types ───────────────────────────────────────────
export type {
  Draft14Message,
  Draft14MessageType,
  Draft14ClientSetup,
  Draft14ServerSetup,
  Draft14Subscribe,
  Draft14SubscribeOk,
  Draft14SubscribeError,
  Draft14SubscribeUpdate,
  Draft14Unsubscribe,
  Draft14Publish,
  Draft14PublishOk,
  Draft14PublishError,
  Draft14PublishDone,
  Draft14PublishNamespace,
  Draft14PublishNamespaceOk,
  Draft14PublishNamespaceError,
  Draft14PublishNamespaceDone,
  Draft14PublishNamespaceCancel,
  Draft14SubscribeNamespace,
  Draft14SubscribeNamespaceOk,
  Draft14SubscribeNamespaceError,
  Draft14UnsubscribeNamespace,
  Draft14Fetch,
  Draft14FetchOk,
  Draft14FetchError,
  Draft14FetchCancel,
  Draft14TrackStatus,
  Draft14TrackStatusOk,
  Draft14TrackStatusError,
  Draft14GoAway,
  Draft14MaxRequestId,
  Draft14RequestsBlocked,
  Draft14Params,
} from '@moqtap/codec/draft14';

// ─── Unified type for the extension's UI layer ────────────────────────
import type { MoqtMessage } from '@moqtap/codec';
import type { Draft14Message } from '@moqtap/codec/draft14';

/** A control message from any supported draft */
export type AnyControlMessage = MoqtMessage | Draft14Message;

// ─── Wire IDs for UI display (draft-14, Table 1) ─────────────────────
export {
  MSG_CLIENT_SETUP,
  MSG_SERVER_SETUP,
  MSG_SUBSCRIBE,
  MSG_SUBSCRIBE_OK,
  MSG_SUBSCRIBE_ERROR,
  MSG_SUBSCRIBE_UPDATE,
  MSG_UNSUBSCRIBE,
  MSG_PUBLISH,
  MSG_PUBLISH_OK,
  MSG_PUBLISH_ERROR,
  MSG_PUBLISH_DONE,
  MSG_PUBLISH_NAMESPACE,
  MSG_PUBLISH_NAMESPACE_OK,
  MSG_PUBLISH_NAMESPACE_ERROR,
  MSG_PUBLISH_NAMESPACE_DONE,
  MSG_PUBLISH_NAMESPACE_CANCEL,
  MSG_SUBSCRIBE_NAMESPACE,
  MSG_SUBSCRIBE_NAMESPACE_OK,
  MSG_SUBSCRIBE_NAMESPACE_ERROR,
  MSG_UNSUBSCRIBE_NAMESPACE,
  MSG_FETCH,
  MSG_FETCH_OK,
  MSG_FETCH_ERROR,
  MSG_FETCH_CANCEL,
  MSG_GOAWAY,
  MSG_MAX_REQUEST_ID,
  MSG_REQUESTS_BLOCKED,
  MSG_TRACK_STATUS,
  MSG_TRACK_STATUS_OK,
  MSG_TRACK_STATUS_ERROR,
  MESSAGE_ID_MAP,
  MESSAGE_TYPE_MAP,
} from '@moqtap/codec/draft14';
