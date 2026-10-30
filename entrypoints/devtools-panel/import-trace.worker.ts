import { type ImportReply, type ImportRequest, runImport } from './import-job'

// The panel's tsconfig has the DOM lib only.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ImportRequest>) => void) | null
  postMessage(reply: ImportReply, transfer: Transferable[]): void
}

scope.onmessage = (e) => {
  void runImport(e.data, (reply, transfer) =>
    scope.postMessage(reply, transfer ?? []),
  )
}
