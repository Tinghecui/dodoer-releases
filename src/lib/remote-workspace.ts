import { getShellTransport, isDesktop } from "@/lib/transport"
import type {
  RemoteWorkspaceConnection,
  RemoteWorkspaceConnectionInput,
} from "@/lib/types"

export async function listRemoteWorkspaceConnections(): Promise<
  RemoteWorkspaceConnection[]
> {
  return getShellTransport().call("list_remote_workspace_connections")
}

export async function getRemoteWorkspaceConnection(
  id: number
): Promise<RemoteWorkspaceConnection> {
  return getShellTransport().call("get_remote_workspace_connection", { id })
}

export async function testRemoteWorkspaceConnection(
  input: RemoteWorkspaceConnectionInput
): Promise<void> {
  return getShellTransport().call("test_remote_workspace_connection", { input })
}

export async function createRemoteWorkspaceConnection(
  input: RemoteWorkspaceConnectionInput
): Promise<RemoteWorkspaceConnection> {
  return getShellTransport().call("create_remote_workspace_connection", {
    input,
  })
}

export async function updateRemoteWorkspaceConnection(
  id: number,
  input: RemoteWorkspaceConnectionInput
): Promise<RemoteWorkspaceConnection> {
  return getShellTransport().call("update_remote_workspace_connection", {
    id,
    input,
  })
}

export async function deleteRemoteWorkspaceConnection(
  id: number
): Promise<void> {
  return getShellTransport().call("delete_remote_workspace_connection", { id })
}

export async function reorderRemoteWorkspaceConnections(
  ids: number[]
): Promise<void> {
  return getShellTransport().call("reorder_remote_workspace_connections", {
    ids,
  })
}

export async function openRemoteWorkspace(id: number): Promise<void> {
  return getShellTransport().call("open_remote_workspace", { id })
}

export async function openLocalWorkspace(): Promise<void> {
  return getShellTransport().call("open_local_workspace")
}

/** 后端在门户「在桌面版打开」换到新令牌后发的事件，载荷是连接 id */
export const REMOTE_CONNECTION_TOKEN_UPDATED_EVENT =
  "remote-connection://token-updated"

/**
 * 订阅「这个连接的令牌刚换过」。走 Tauri 本机事件而不是 getTransport()：
 * 远端窗口的 transport 指向远端，读不到钥匙串时又根本没配。网页版没有这件事。
 */
export async function listenRemoteConnectionTokenUpdated(
  handler: (connectionId: number) => void
): Promise<() => void> {
  if (!isDesktop()) return () => {}
  const { listen } = await import("@tauri-apps/api/event")
  return listen<number>(REMOTE_CONNECTION_TOKEN_UPDATED_EVENT, (event) =>
    handler(event.payload)
  )
}
