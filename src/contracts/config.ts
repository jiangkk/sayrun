export type ApprovalMode = 'ask' | 'normal' | 'full';
export interface BackendSettings {
  binary?: string; model?: string; api_key_env?: string; credentials?: string;
  manifest?: string; version?: string; disabled?: boolean;
}
export interface Config {
  schema_version: number;
  agent: { backend: string; max_commands: number; max_steps: number; max_questions: number; active_timeout_seconds: number };
  routing: { mode: 'auto' | 'local' | 'explicit'; classifier: string; confidence_threshold: number; timeout_seconds: number; on_ambiguous: 'ask' };
  ui: { mode: 'opentui' | 'plain'; language: string; color: 'auto' | 'always' | 'never'; output_preview_lines: number };
  approval: { mode: ApprovalMode; default_selection: 'approve' | 'reject' | 'edit'; editor_enter: 'execute' | 'save' };
  execution: { executor: 'local-zsh'; shell: string; timeout_seconds: number; max_output_bytes: number };
  history: { enabled: boolean; default_scope: 'project' | 'all'; auto_gc: boolean; retention_days: number; max_total_mb: number; store_command_output: boolean; include_classifier: boolean };
  backends: Record<string, BackendSettings>;
  context: { text: string };
  profiles: Record<string, ConfigPatch>;
}

export type ConfigPatch = { [K in keyof Config]?: K extends 'profiles' ? Config['profiles'] : K extends 'backends' ? Config['backends'] : Config[K] extends object ? Partial<Config[K]> : Config[K] };
