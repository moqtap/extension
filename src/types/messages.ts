/**
 * MoQT control message type re-exports from @moqtap/codec.
 *
 * Draft-07 uses the generic MoqtMessage types (camelCase).
 * Draft-14 uses Draft14Message types (snake_case).
 */

// ─── Draft-07 message types ────────────────────────────────────────────
export type {
  Announce,
  AnnounceCancel,
  AnnounceError,
  AnnounceOk,
  ClientSetup,
  Fetch,
  FetchCancel,
  FetchError,
  FetchOk,
  FilterType,
  GoAway,
  GroupOrderValue,
  MaxSubscribeId,
  MoqtMessage,
  MoqtMessageType,
  ServerSetup,
  Subscribe,
  SubscribeAnnounces,
  SubscribeAnnouncesError,
  SubscribeAnnouncesOk,
  SubscribeDone,
  SubscribeError,
  SubscribeOk,
  SubscribeUpdate,
  TrackStatus,
  TrackStatusRequest,
  Unannounce,
  Unsubscribe,
  UnsubscribeAnnounces,
} from '@moqtap/codec'

// ─── Draft-14 message types ───────────────────────────────────────────
export type {
  Draft14ClientSetup,
  Draft14Fetch,
  Draft14FetchCancel,
  Draft14FetchError,
  Draft14FetchOk,
  Draft14GoAway,
  Draft14MaxRequestId,
  Draft14Message,
  Draft14MessageType,
  Draft14Params,
  Draft14Publish,
  Draft14PublishDone,
  Draft14PublishError,
  Draft14PublishNamespace,
  Draft14PublishNamespaceCancel,
  Draft14PublishNamespaceDone,
  Draft14PublishNamespaceError,
  Draft14PublishNamespaceOk,
  Draft14PublishOk,
  Draft14RequestsBlocked,
  Draft14ServerSetup,
  Draft14Subscribe,
  Draft14SubscribeError,
  Draft14SubscribeNamespace,
  Draft14SubscribeNamespaceError,
  Draft14SubscribeNamespaceOk,
  Draft14SubscribeOk,
  Draft14SubscribeUpdate,
  Draft14TrackStatus,
  Draft14TrackStatusError,
  Draft14TrackStatusOk,
  Draft14Unsubscribe,
  Draft14UnsubscribeNamespace,
} from '@moqtap/codec/draft14'

// ─── Unified type for the extension's UI layer ────────────────────────
import type { MoqtMessage } from '@moqtap/codec'
import type { Draft14Message } from '@moqtap/codec/draft14'

/** A control message from any supported draft */
export type AnyControlMessage = MoqtMessage | Draft14Message

// ─── Wire IDs for UI display (draft-14, Table 1) ─────────────────────
export {
  MESSAGE_ID_MAP,
  MESSAGE_TYPE_MAP,
  MSG_CLIENT_SETUP,
  MSG_FETCH,
  MSG_FETCH_CANCEL,
  MSG_FETCH_ERROR,
  MSG_FETCH_OK,
  MSG_GOAWAY,
  MSG_MAX_REQUEST_ID,
  MSG_PUBLISH,
  MSG_PUBLISH_DONE,
  MSG_PUBLISH_ERROR,
  MSG_PUBLISH_NAMESPACE,
  MSG_PUBLISH_NAMESPACE_CANCEL,
  MSG_PUBLISH_NAMESPACE_DONE,
  MSG_PUBLISH_NAMESPACE_ERROR,
  MSG_PUBLISH_NAMESPACE_OK,
  MSG_PUBLISH_OK,
  MSG_REQUESTS_BLOCKED,
  MSG_SERVER_SETUP,
  MSG_SUBSCRIBE,
  MSG_SUBSCRIBE_ERROR,
  MSG_SUBSCRIBE_NAMESPACE,
  MSG_SUBSCRIBE_NAMESPACE_ERROR,
  MSG_SUBSCRIBE_NAMESPACE_OK,
  MSG_SUBSCRIBE_OK,
  MSG_SUBSCRIBE_UPDATE,
  MSG_TRACK_STATUS,
  MSG_TRACK_STATUS_ERROR,
  MSG_TRACK_STATUS_OK,
  MSG_UNSUBSCRIBE,
  MSG_UNSUBSCRIBE_NAMESPACE,
} from '@moqtap/codec/draft14'
