// Cowork fork (daemon/client split, step 2): where a command goes when the
// app's daemon is a child process (`src-tauri/src/local_daemon.rs`).
//
// The child is a `codeg-server`, so it answers every command the server's
// router has. What it cannot answer is what only the app can do — windows,
// the tray, native dialogs, the built-in browser, the remote-workspace proxy,
// computer use's screen sharing — and those stay with the app.
//
// - SHELL_ONLY_COMMANDS: the app's Tauri commands with no server route. Kept
//   equal to "invoke_handler minus router" by `local-daemon-routing.test.ts`,
//   which reads the Rust sources: a new desktop-only command fails that test
//   until it is put here (or given a server route).
// - SHELL_COMMANDS: commands the server also has, but whose desktop
//   implementation is the one that must run — it acts on the app itself.
// - BOTH_COMMANDS: settings both processes keep live (the child persists
//   them; the app applies them to what it runs itself — its tray, its log
//   level, the browser / computer-use tools it serves to the child).

export type LocalDaemonRoute = "daemon" | "shell" | "both"

export const SHELL_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "acp_open_hermes_setup_terminal",
  "acp_reveal_hermes_home",
  "app_rollback_target",
  "backup_create",
  "browser_agent_act",
  "browser_agent_capture",
  "browser_agent_console",
  "browser_agent_eval",
  "browser_agent_grant",
  "browser_agent_snapshot",
  "browser_answer_open_request",
  "browser_capabilities",
  "browser_chrome_activate",
  "browser_chrome_agents",
  "browser_chrome_connect",
  "browser_chrome_disconnect",
  "browser_chrome_open_privacy_settings",
  "browser_chrome_set_agents",
  "browser_chrome_share",
  "browser_chrome_status",
  "browser_chrome_tabs",
  "browser_clear_data",
  "browser_clear_downloads",
  "browser_close",
  "browser_doc_open",
  "browser_doc_set_mode",
  "browser_doc_state",
  "browser_eval_decide",
  "browser_find",
  "browser_freeze_frame",
  "browser_get_state",
  "browser_go_back",
  "browser_go_forward",
  "browser_list_downloads",
  "browser_list_services",
  "browser_list_tabs",
  "browser_navigate",
  "browser_open_devtools",
  "browser_open_tab",
  "browser_page_capture",
  "browser_page_console",
  "browser_pick_cancel",
  "browser_pick_element",
  "browser_reload",
  "browser_remove_profile",
  "browser_reveal_download",
  "browser_set_blank_page_theme",
  "browser_set_bounds",
  "browser_set_host_rules",
  "browser_set_sign_in_user_agent",
  "browser_set_visible",
  "browser_set_window_viewport",
  "browser_stop",
  "cli_tool_install",
  "cli_tool_status",
  "close_pet_panel",
  "close_pet_window",
  "computer_indicator_fit",
  "config_sync_export_file",
  "config_sync_import_file",
  "config_sync_peek_file",
  "copy_files_to_clipboard",
  "create_remote_workspace_connection",
  "delete_remote_workspace_connection",
  "focus_conversation",
  "get_accessibility_display_options",
  "get_remote_workspace_connection",
  "get_system_autostart_settings",
  "get_system_close_behavior_settings",
  "get_system_rendering_settings",
  "host_ssh_self_test",
  "host_ssh_set_lent",
  "host_ssh_status",
  "list_remote_workspace_connections",
  "local_daemon_attach_window",
  "local_daemon_status",
  "notification_identity",
  "open_folder_window",
  "open_local_workspace",
  "open_logs_dir",
  "open_pet_window",
  "open_project_boot_window",
  "open_remote_workspace",
  "open_system_notification_settings",
  "perform_app_rollback",
  "pet_show_context_menu",
  "pet_window_record_position",
  "read_clipboard_files",
  "read_local_file_for_upload",
  "remote_cancel_workspace_transfer",
  "remote_download_workspace_dir",
  "remote_download_workspace_file",
  "remote_http_call",
  "remote_upload_attachment",
  "remote_upload_workspace_paths",
  "remote_ws_send_text",
  "remote_ws_subscribe",
  "remote_ws_unsubscribe",
  "reorder_remote_workspace_connections",
  "resize_pet_panel",
  "resolve_close_request",
  "run_local_command",
  "save_binary_file",
  "save_pasted_attachment",
  "save_text_file",
  "send_notification",
  "set_tray_locale",
  "take_pending_deep_link",
  "take_workspace_restore_failures",
  "test_remote_workspace_connection",
  "toggle_pet_panel",
  "update_appearance_mode",
  "update_remote_workspace_connection",
  "update_system_autostart_settings",
  "update_system_close_behavior_settings",
  "update_system_rendering_settings",
  "update_traffic_light_position",
])

export const SHELL_COMMANDS: ReadonlySet<string> = new Set([
  // Windows of the app.
  "open_commit_window",
  "open_settings_window",
  "open_merge_window",
  "open_push_window",
  "open_stash_window",
  "open_import_sessions_window",
  // The app's own updater and restart (the child is inside the bundle).
  "app_update_state",
  "perform_app_update",
  "restart_app",
  // Computer use: the service and its sharing panel live in the app; the
  // child's agents reach them over the host bridge.
  "computer_driver_info",
  "computer_driver_install",
  "computer_driver_uninstall",
  "computer_list_shareable_windows",
  "computer_open_permission_settings",
  "computer_request_permission",
  "computer_reveal_helper",
  "computer_revoke_all",
  "computer_share_app",
  "computer_share_screen",
  "computer_share_window",
  "computer_share_windows",
  "computer_shared_state",
  "computer_status",
  "computer_stop",
  "computer_stop_key_status",
  "computer_window_thumbnail",
  // The web service is the in-process daemon's (see `start_web_server`).
  "get_web_server_status",
  "start_web_server",
  "stop_web_server",
])

export const BOTH_COMMANDS: ReadonlySet<string> = new Set([
  "update_system_language_settings",
  "update_system_proxy_settings",
  "set_log_settings",
  "set_browser_tools_settings",
  // The status popover's switches: the browser and computer-use groups are
  // served by the app, which reads its own copy of them.
  "set_codeg_mcp_tool_group",
  "set_computer_tools_enabled",
  "set_computer_tools_settings",
  "set_computer_tools_preferences",
])

export function localDaemonRoute(command: string): LocalDaemonRoute {
  if (SHELL_ONLY_COMMANDS.has(command) || SHELL_COMMANDS.has(command)) {
    return "shell"
  }
  if (BOTH_COMMANDS.has(command)) return "both"
  return "daemon"
}
